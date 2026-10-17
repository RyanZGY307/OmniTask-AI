import asyncio, json
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PY = "/root/workspace/.headroom-venv/bin/python"
SRV = "/root/workspace/headroom-py/server.py"


async def main():
    params = StdioServerParameters(command=PY, args=[SRV], env=None)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()
            tools = await s.list_tools()
            names = [t.name for t in tools.tools]
            print("tools:", names)
            assert "headroom_compress" in names and "headroom_retrieve" in names and "headroom_stats" in names

            payload = json.dumps({"results": [{"id": i % 3, "status": "ok" if i % 4 else "err", "blob": "z" * 200} for i in range(40)]})
            res = await s.call_tool("headroom_compress", {"content": payload, "kind": "json"})
            blob = json.loads(res.content[0].text)
            print("compress saved_pct:", blob["saved_pct"], "handle:", blob["handle"])
            rec = await s.call_tool("headroom_retrieve", {"handle": blob["handle"]})
            rblob = json.loads(rec.content[0].text)
            assert rblob["ok"] and rblob["original"] == payload, "retrieve mismatch"
            print("retrieve round-trip OK, len:", len(rblob["original"]))
            stats = json.loads((await s.call_tool("headroom_stats", {})).content[0].text)
            print("stats:", stats.get("count"), "compressions, saved_tokens≈", stats.get("tokens_saved"))
            print("\nMCP SMOKE PASSED")


asyncio.run(main())
