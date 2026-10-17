"""并发调度与重试（F4）。

- 线程池并发多设备任务；单设备失败不影响其它设备（future 级隔离）。
- 仅对 is_retryable 的错误做指数退避重试（base * 2^attempt，封顶 max_delay）。
- 提供 progress(done, total, result) 回调。
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from .device import AdbDevice
from .utils.errors import AdbError, is_retryable

log = logging.getLogger("orchestrator.runner")


@dataclass
class TaskResult:
    serial: str
    success: bool
    output: str = ""
    error: str = ""
    attempts: int = 1
    duration: float = 0.0
    retried: bool = False


class Runner:
    """多设备任务调度器。task 形如 callable(device)->str，可抛 AdbError。"""

    def __init__(
        self,
        max_workers: int = 8,
        max_retries: int = 2,
        base_delay: float = 1.0,
        max_delay: float = 30.0,
    ):
        self.max_workers = max_workers
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay

    def run_tasks(
        self,
        tasks: List[Tuple[AdbDevice, Callable[[AdbDevice], str]]],
        progress: Optional[Callable[[int, int, TaskResult], None]] = None,
    ) -> List[TaskResult]:
        results: List[TaskResult] = []
        if not tasks:
            return results

        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            future_map = {
                pool.submit(self._run_one, dev, task): dev for dev, task in tasks
            }
            total = len(future_map)
            done = 0
            for fut in as_completed(future_map):
                dev = future_map[fut]
                try:
                    result = fut.result()
                except Exception as exc:  # noqa: BLE001 - 隔离单设备，兜底不让整批崩
                    log.exception("任务未捕获异常 serial=%s", dev.serial)
                    result = TaskResult(dev.serial, False, error=str(exc))
                results.append(result)
                done += 1
                if progress:
                    progress(done, total, result)
        return results

    def _run_one(
        self, dev: AdbDevice, task: Callable[[AdbDevice], str]
    ) -> TaskResult:
        last_err: Optional[BaseException] = None
        t0 = time.monotonic()
        for attempt in range(self.max_retries + 1):
            try:
                output = task(dev)
                return TaskResult(
                    dev.serial,
                    True,
                    output=output if isinstance(output, str) else str(output),
                    attempts=attempt + 1,
                    duration=time.monotonic() - t0,
                    retried=attempt > 0,
                )
            except AdbError as exc:
                last_err = exc
                if not is_retryable(exc) or attempt >= self.max_retries:
                    break
                delay = min(self.max_delay, self.base_delay * (2 ** attempt))
                log.warning(
                    "serial=%s 第 %d 次失败（%s: %s），%.1fs 后重试",
                    dev.serial, attempt + 1, type(exc).__name__, exc, delay,
                )
                time.sleep(delay)
            except Exception as exc:  # noqa: BLE001 - 非 adb 错误不重试，直接失败
                last_err = exc
                log.error("serial=%s 不可重试异常: %s", dev.serial, exc)
                break
        return TaskResult(
            dev.serial,
            False,
            error=str(last_err),
            attempts=self.max_retries + 1,
            duration=time.monotonic() - t0,
            retried=True,
        )
