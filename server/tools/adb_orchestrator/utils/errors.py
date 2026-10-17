"""类型化异常体系。

- AdbError            基类，携带 serial/rc/stdout/stderr 上下文。
- AdbCommandError     命令真实失败（rc != 0），一般不可恢复。
- AdbTimeoutError     超时，子进程组已被 SIGKILL，可恢复（重试）。
- AdbDeviceOfflineError 设备 offline/unauthorized/未连接，可恢复（重试）。

可恢复判定集中在 is_retryable()，调度层据此决定是否指数退避重试。
"""

from typing import Optional


class AdbError(Exception):
    """所有 adb-orchestrator 错误的基类。"""

    def __init__(
        self,
        serial: str,
        message: str,
        rc: Optional[int] = None,
        stdout: Optional[str] = None,
        stderr: Optional[str] = None,
    ):
        super().__init__(message)
        self.serial = serial
        self.rc = rc
        self.stdout = stdout
        self.stderr = stderr


class AdbCommandError(AdbError):
    """adb 以非零返回码退出（真实命令失败）。"""


class AdbTimeoutError(AdbError):
    """命令超时；子进程组已被强制回收。"""


class AdbDeviceOfflineError(AdbError):
    """设备 offline / unauthorized / 不可达。"""


# 可恢复（值得重试）的错误：超时与设备离线。真实命令失败默认不重试。
_RETRYABLE = (AdbTimeoutError, AdbDeviceOfflineError)


def is_retryable(err: BaseException) -> bool:
    """判断异常是否值得触发重试（供 runner 使用）。"""
    return isinstance(err, _RETRYABLE)
