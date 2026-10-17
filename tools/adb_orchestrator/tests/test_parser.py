import unittest

from adb_orchestrator.parser import LogcatParser


def feed_many(p: LogcatParser, lines):
    for l in lines:
        p.feed(l)


class TestThreadtime(unittest.TestCase):
    def test_parse_record_fields(self):
        p = LogcatParser()
        r = p.feed("01-15 12:00:00.123  1234  1235  I/ActivityManager: start proc")
        self.assertIsNotNone(r)
        self.assertEqual(r.ts, "01-15 12:00:00.123")
        self.assertEqual((r.pid, r.tid), (1234, 1235))
        self.assertEqual((r.level, r.tag), ("I", "ActivityManager"))
        self.assertEqual(r.msg, "start proc")
        self.assertEqual(r.buffer, "main")


class TestMultiline(unittest.TestCase):
    def test_stack_lines_merge_into_previous(self):
        p = LogcatParser()
        p.feed("01-15 12:00:00.000  1  1  E/AndroidRuntime: FATAL EXCEPTION: main")
        r2 = p.feed("    at com.example.App.onCreate(App.java:10)")
        self.assertIsNone(r2)  # 续行不产生新记录
        self.assertEqual(len(p.records), 1)
        self.assertIn("\n", p.records[0].msg)
        self.assertIn("com.example.App", p.records[0].msg)


class TestBuffer(unittest.TestCase):
    def test_mixed_buffers_tracked(self):
        p = LogcatParser()
        p.feed("----------- beginning of main -----------")
        r = p.feed("01-15 12:00:00.000  1  1  D/foo: hi")
        self.assertEqual(r.buffer, "main")
        p.feed("----------- beginning of crash -----------")
        r2 = p.feed("01-15 12:00:01.000  2  2  F/crash: boom")
        self.assertEqual(r2.buffer, "crash")


class TestFind(unittest.TestCase):
    def setUp(self):
        self.p = LogcatParser()
        feed_many(self.p, [
            "01-15 12:00:00.000  1  1  E/AndroidRuntime: FATAL EXCEPTION: main",
            "    at com.x.Main.on(Main.java:1)",
            "01-15 12:00:02.000  2  2  E/ActivityManager: ANR in com.example.app (app/Main)",
            "01-15 12:00:03.000  3  3  E/Watchdog: timed out ... held for more than 3000ms",
            "01-15 12:00:04.000  4  4  I/app: normal",
        ])

    def test_find_crash(self):
        self.assertTrue(any("FATAL EXCEPTION" in r.msg for r in self.p.find_crash()))

    def test_find_anr(self):
        self.assertTrue(any("ANR in" in r.msg for r in self.p.find_anr()))

    def test_find_watchdog(self):
        self.assertTrue(any(r.tag == "Watchdog" for r in self.p.find_watchdog()))

    def test_boundary_stray_lines_dropped(self):
        q = LogcatParser()
        self.assertIsNone(q.feed(""))
        self.assertIsNone(q.feed("stray line before any record"))
        self.assertEqual(q.records, [])


if __name__ == "__main__":
    unittest.main()
