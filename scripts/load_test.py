#!/usr/bin/env python3
"""WebSocket load test for one whiteboard room.

Starts N students, lets them draw rectangles at a fixed rate and measures how
long it takes for the other clients to receive each event.

Usage:
    python scripts/load_test.py --clients 20 --duration 15
    python scripts/load_test.py --base-url http://127.0.0.1:8000 --clients 50

Requires httpx and websockets (both are in backend/requirements-dev.txt).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

import httpx
import websockets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Whiteboard WebSocket load test")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--room", default=f"load-{int(time.time())}")
    parser.add_argument("--clients", type=int, default=10)
    parser.add_argument("--duration", type=float, default=10.0)
    parser.add_argument("--interval", type=float, default=0.5, help="seconds between shapes")
    parser.add_argument("--max-errors", type=int, default=0)
    parser.add_argument("--max-p95-ms", type=float, default=500.0)
    return parser.parse_args()


@dataclass
class Stats:
    sent: int = 0
    received: int = 0
    errors: int = 0
    latencies: list[float] = field(default_factory=list)
    error_samples: list[str] = field(default_factory=list)


async def login_all(base_url: str, room: str, count: int) -> list[str]:
    tokens: list[str] = []
    async with httpx.AsyncClient(base_url=base_url, timeout=15) as client:
        for index in range(count):
            response = await client.post(
                "/api/login",
                json={"name": f"Load-{index + 1}", "roomId": room, "role": "student"},
            )
            response.raise_for_status()
            tokens.append(response.json()["token"])
    return tokens


def ws_url(base_url: str, room: str, token: str) -> str:
    scheme = "wss" if base_url.startswith("https") else "ws"
    host = base_url.split("://", 1)[1].rstrip("/")
    return f"{scheme}://{host}/ws/{urllib.parse.quote(room)}?token={urllib.parse.quote(token)}"


def shape(index: int, sequence: int) -> dict[str, Any]:
    return {
        "type": "shape_add",
        "objectId": f"load-{index}-{sequence}",
        "shapeType": "rect",
        "x": float((index * 37 + sequence) % 1400),
        "y": float((index * 53 + sequence) % 800),
        "width": 40.0,
        "height": 30.0,
        "color": "#2563eb",
        "strokeWidth": 2.0,
        "fill": "#ffffff",
    }


async def client_loop(
    index: int,
    token: str,
    args: argparse.Namespace,
    stats: Stats,
    sent_at: dict[str, float],
    start: asyncio.Event,
) -> None:
    async with websockets.connect(ws_url(args.base_url, args.room, token)) as socket:
        await socket.recv()  # init
        stop = asyncio.Event()

        async def reader() -> None:
            try:
                async for raw in socket:
                    message = json.loads(raw)
                    stats.received += 1
                    if message.get("type") == "error":
                        stats.errors += 1
                        if len(stats.error_samples) < 10:
                            stats.error_samples.append(str(message))
                    elif message.get("type") == "shape_add":
                        object_id = message.get("object", {}).get("id")
                        sent = sent_at.pop(object_id, None)
                        if sent is not None:
                            stats.latencies.append((time.perf_counter() - sent) * 1000)
                    if stop.is_set():
                        break
            except websockets.ConnectionClosed:
                pass

        reader_task = asyncio.create_task(reader())
        await start.wait()
        deadline = time.monotonic() + args.duration
        sequence = 0
        try:
            while time.monotonic() < deadline:
                object_id = f"load-{index}-{sequence}"
                sent_at[object_id] = time.perf_counter()
                await socket.send(json.dumps(shape(index, sequence)))
                stats.sent += 1
                sequence += 1
                await asyncio.sleep(args.interval)
            await asyncio.sleep(0.5)
        finally:
            stop.set()
            reader_task.cancel()
            await asyncio.gather(reader_task, return_exceptions=True)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = min(len(ordered) - 1, int(round((len(ordered) - 1) * fraction)))
    return ordered[position]


async def main() -> int:
    args = parse_args()
    if args.clients < 1:
        print("--clients must be >= 1", file=sys.stderr)
        return 2

    try:
        tokens = await login_all(args.base_url, args.room, args.clients)
    except Exception as exc:  # noqa: BLE001 - CLI should print a clean error
        print(f"Login failed: {exc}", file=sys.stderr)
        return 2

    stats = Stats()
    sent_at: dict[str, float] = {}
    start = asyncio.Event()
    tasks = [
        asyncio.create_task(client_loop(i, token, args, stats, sent_at, start))
        for i, token in enumerate(tokens)
    ]
    started = time.perf_counter()
    start.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    elapsed = time.perf_counter() - started

    failures = [result for result in results if isinstance(result, Exception)]
    for failure in failures[:3]:
        print(f"Client failed: {failure}", file=sys.stderr)

    p50 = percentile(stats.latencies, 0.5)
    p95 = percentile(stats.latencies, 0.95)
    p99 = percentile(stats.latencies, 0.99)
    report = {
        "room": args.room,
        "clients": args.clients,
        "duration_s": round(elapsed, 2),
        "sent": stats.sent,
        "received": stats.received,
        "errors": stats.errors,
        "failed_clients": len(failures),
        "sent_per_sec": round(stats.sent / elapsed, 1) if elapsed else 0,
        "latency_ms": {
            "p50": round(p50, 1),
            "p95": round(p95, 1),
            "p99": round(p99, 1),
            "max": round(max(stats.latencies), 1) if stats.latencies else 0,
        },
        "error_samples": stats.error_samples,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if failures:
        return 1
    if stats.errors > args.max_errors:
        return 1
    if stats.latencies and p95 > args.max_p95_ms:
        print(f"p95 {p95:.1f} ms exceeds --max-p95-ms {args.max_p95_ms}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
