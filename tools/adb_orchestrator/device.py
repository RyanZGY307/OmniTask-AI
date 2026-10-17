"""单设备 ADB 封装。

设计要点：
- F1：list_devices() 区分 device/offline/unauthorized/recovery/sideload/bootloader/no permissions。
- 属性 state/model/sdk/abi/battery 采用「取一次、缓一份」，避免每次访问都起进程。
- F2：run(cmd, timeout) 强制以列表传参（禁 shell=True），超时用 start_new_session +
  os.killpg 真正杀死子进程组；异常类型化为 AdbCommandError/AdbTimeoutError/
  AdbDeviceOfflineError。
"""

import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

from .utils.errors import (
    AdbCommandError,
    AdbDeviceOfflineError,
    AdbError,
    AdbTimeoutError,
)

log = logging.getLogger("orchestrator.device")


class DeviceState(Enum):
    """adb devices 可能出现的设备状态（含 Linux 主机侧 no permissions）。"""

    DEVICE = "device"
    OFFLINE = "offline"
    UNAUTHORIZED = "unauthorized"
    RECOVERY = "recovery"
    SIDELOAD = "sideload"
    BOOTLOADER = "bootloader"
    NO_PERMISSIONS = "no permissions"

    @classmethod
    def parse(cls, raw: str) -> str:
        raw = raw.strip()
        for s in cls:
            if s.value == raw:
                return raw
        return cls.OFFLINE.value


@dataclass
class CmdResult:
    """一次 adb 命令执行结果。"""

    rc: int
    stdout: str
    stderr: str
    duration: float


# 设备侧不可达（可重试）的识别特征，集中在 stderr/stdout 里扫描。
_OFFLINE_MARKERS = (
    "error: device offline",
    "device offline",
    "error: device unauthorized",
    "device unauthorized",
    "error: no devices",
    "error: device not found",
    "cannot connect to device",
)


class AdbDevice:
    """对单台设备的封装。adb_bin 可注入（默认 "adb"），便于测试 mock。"""

    def __init__(self, serial: str, state: str = DeviceState.DEVICE.value,
                 adb_bin: str = "adb"):
        self.serial = serial
        self.state = state
        self._adb = adb_bin
        self._lock = threading.Lock()
        self._profile: Optional[dict] = None

    # ---------- F1：设备清单 ----------
    @classmethod
    def list_devices(cls, adb_bin: str = "adb", timeout: int = 15) -> List["AdbDevice"]:
        """返回结构化设备对象列表。"""
        proc = subprocess.run(
            [adb_bin, "devices"],
            start_new_session=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=timeout,
        )
        devices: List[AdbDevice] = []
        for line in proc.stdout.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line or line.startswith("List of"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            serial = parts[0].strip()
            state = DeviceState.parse(parts[1])
            devices.append(cls(serial, state=state, adb_bin=adb_bin))
        return devices

    # ---------- F1：lazy 属性（取一次缓一份，线程安全） ----------
    @property
    def _props(self) -> dict:
        with self._lock:
            if self._profile is None:
                self._profile = self._fetch_profile()
            return self._profile

    @property
    def model(self) -> str:
        return self._props.get("model", "")

    @property
    def sdk(self) -> str:
        return self._props.get("sdk", "")

    @property
    def abi(self) -> str:
        return self._props.get("abi", "")

    @property
    def battery(self) -> str:
        return self._props.get("battery", "")

    def _fetch_profile(self) -> dict:
        """用**一次** shell 调用取齐 model/sdk/abi/battery，避免多次起进程。

        设备不可达时优雅退化为空 profile，而不是抛错，保证 list 场景可用性。
        """
        probe = (
            "getprop ro.product.model; "
            "getprop ro.build.version.sdk; "
            "getprop ro.product.cpu.abi; "
            "dumpsys battery | grep -E 'level:|status:'"
        )
        try:
            res = self.run(["shell", probe], timeout=15)
            out = res.stdout
        except AdbError:
            out = ""
        lines = [l for l in out.splitlines() if l.strip()]
        prof = {
            "model": lines[0] if len(lines) > 0 else "",
            "sdk": lines[1] if len(lines) > 1 else "",
            "abi": lines[2] if len(lines) > 2 else "",
            "battery": "",
        }
        for l in lines[3:]:
            if "level" in l or "status" in l:
                prof["battery"] = l.strip()
                break
        return prof

    # ---------- F2：命令执行 ----------
    def run(self, cmd: List[str], timeout: int = 30) -> CmdResult:
        """执行一条 adb 命令（cmd 为列表，绝不拼字符串、绝不 shell=True）。

        返回 CmdResult；失败抛类型化异常：
        - 设备不可达 -> AdbDeviceOfflineError
        - rc != 0     -> AdbCommandError
        - 超时        -> AdbTimeoutError（且已回收子进程组）
        """
        argv = [self._adb, "-s", self.serial] + list(cmd)
        start = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv,
                start_new_session=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
            )
        except (FileNotFoundError, OSError) as exc:
            raise AdbCommandError(self.serial, f"无法执行 {self._adb}: {exc}")

        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._kill_process_group(proc)
            raise AdbTimeoutError(self.serial, f"adb 超时（>{timeout}s）")

        duration = time.monotonic() - start
        stdout = out.decode("utf-8", "replace").strip()
        stderr = err.decode("utf-8", "replace").strip()
        result = CmdResult(proc.returncode, stdout, stderr, duration)

        self._raise_if_device_unreachable(result)
        if result.rc != 0:
            raise AdbCommandError(
                self.serial, f"adb rc={result.rc}", result.rc, result.stdout, result.stderr
            )
        log.debug("adb ok: %s (%.3fs)", " ".join(argv), duration)
        return result

    def _raise_if_device_unreachable(self, result: CmdResult) -> None:
        blob = (result.stdout + "\n" + result.stderr).lower()
        for marker in _OFFLINE_MARKERS:
            if marker in blob:
                raise AdbDeviceOfflineError(
                    self.serial,
                    f"设备不可达: {result.stderr or result.stdout}",
                    result.rc,
                    result.stdout,
                    result.stderr,
                )

    @staticmethod
    def _kill_process_group(proc: "subprocess.Popen") -> None:
        """start_new_session=True 使子进程自成进程组，killpg 才能连子树一起收。"""
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.kill()
        except Exception:  # noqa: BLE001 - 兜底回收，不影响主流程
            pass
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass
