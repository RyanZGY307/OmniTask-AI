import subprocess as sp
import unittest
from unittest import mock

from adb_orchestrator.device import AdbDevice
from adb_orchestrator.utils.errors import (
    AdbCommandError,
    AdbDeviceOfflineError,
    AdbTimeoutError,
)


class TestListDevices(unittest.TestCase):
    def test_parses_states(self):
        fake = mock.Mock()
        fake.returncode = 0
        fake.stdout = b"List of devices attached\ne1\tdevice\ne2\toffline\ne3\tunauthorized\n"
        with mock.patch("subprocess.run", return_value=fake):
            devs = AdbDevice.list_devices(adb_bin="adb")
        self.assertEqual([d.serial for d in devs], ["e1", "e2", "e3"])
        self.assertEqual([d.state for d in devs], ["device", "offline", "unauthorized"])

    def test_ignores_bad_lines(self):
        fake = mock.Mock()
        fake.returncode = 0
        fake.stdout = b"List of devices attached\n\ngarbage\n"
        with mock.patch("subprocess.run", return_value=fake):
            self.assertEqual(AdbDevice.list_devices(adb_bin="adb"), [])


class TestRun(unittest.TestCase):
    def _dev(self):
        return AdbDevice("e1", adb_bin="adb")

    def test_run_ok(self):
        d = self._dev()
        fake = mock.Mock()
        fake.returncode = 0
        fake.communicate.return_value = (b"hello\n", b"")
        with mock.patch("subprocess.Popen", return_value=fake):
            res = d.run(["shell", "echo", "hello"], timeout=5)
        self.assertEqual(res.rc, 0)
        self.assertEqual(res.stdout, "hello")

    def test_run_command_error(self):
        d = self._dev()
        fake = mock.Mock()
        fake.returncode = 1
        fake.communicate.return_value = (b"", b"real failure")
        with mock.patch("subprocess.Popen", return_value=fake):
            with self.assertRaises(AdbCommandError):
                d.run(["shell", "false"], timeout=5)

    def test_run_timeout_kills_process_group(self):
        d = self._dev()
        fake = mock.Mock()
        fake.pid = 4242
        fake.communicate.side_effect = sp.TimeoutExpired("adb", 1)
        with mock.patch("subprocess.Popen", return_value=fake), \
                mock.patch("os.getpgid", return_value=4242), \
                mock.patch("os.killpg") as kp:
            with self.assertRaises(AdbTimeoutError):
                d.run(["shell", "sleep", "10"], timeout=1)
            kp.assert_called_once()  # 必须真正 kill 进程组

    def test_run_offline_detected(self):
        d = self._dev()
        fake = mock.Mock()
        fake.returncode = 1
        fake.communicate.return_value = (b"", b"error: device offline")
        with mock.patch("subprocess.Popen", return_value=fake):
            with self.assertRaises(AdbDeviceOfflineError):
                d.run(["shell", "true"], timeout=5)


class TestProfile(unittest.TestCase):
    def test_cached_single_fetch(self):
        """反复访问属性只触发一次 _fetch_profile（不每访问一次起一次进程）。"""
        d = AdbDevice("e1")
        calls = {"n": 0}

        def spy(_self):
            calls["n"] += 1
            return {"model": "Pixel", "sdk": "34", "abi": "arm64-v8a",
                    "battery": "level: 80"}

        with mock.patch.object(AdbDevice, "_fetch_profile", spy):
            _ = d.model
            _ = d.sdk
            _ = d.battery
            _ = d.abi
        self.assertEqual(calls["n"], 1)


if __name__ == "__main__":
    unittest.main()
