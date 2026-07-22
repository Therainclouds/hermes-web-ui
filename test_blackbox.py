"""Black-box test: connect to diarize endpoint, send audio, check transcript."""
import asyncio
import json
import math
import struct
import sys
import time
import websockets


def gen_speech_like_pcm(duration_sec: float, sample_rate: int = 16000) -> bytes:
    """Generate PCM that vaguely resembles speech (formants around 300-3000 Hz)."""
    samples = int(duration_sec * sample_rate)
    pcm = bytearray(samples * 2)
    for i in range(samples):
        t = i / sample_rate
        # Mix three formant-like frequencies with amplitude modulation
        f1 = 300 + 200 * math.sin(2 * math.pi * 3 * t)  # 100-500 Hz
        f2 = 1500 + 500 * math.sin(2 * math.pi * 2 * t)  # 1-2 kHz
        f3 = 2500 + 500 * math.sin(2 * math.pi * 1.5 * t)  # 2-3 kHz
        val = int(
            3000 * math.sin(2 * math.pi * f1 * t)
            + 2000 * math.sin(2 * math.pi * f2 * t)
            + 1500 * math.sin(2 * math.pi * f3 * t)
        )
        val = max(-32768, min(32767, val))
        struct.pack_into('<h', pcm, i * 2, val)
    return bytes(pcm)


async def main():
    print("=" * 70)
    print("BLACK-BOX TEST: Speaker Diarization WS Endpoint")
    print("=" * 70)

    # Step 1: Check ASR service health
    import urllib.request
    for port, name in [(8000, "main"), (8001, "diarize")]:
        try:
            req = urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3)
            body = req.read().decode()
            print(f"\n[1] {name} :{port} -> {body[:100]}")
        except Exception as e:
            print(f"\n[1] {name} :{port} -> FAIL: {e}")
            sys.exit(1)

    # Step 2: Connect to diarize WebSocket
    uri = "ws://127.0.0.1:8001/ws/diarize"
    print(f"\n[2] Connecting to {uri} ...")
    t_start = time.monotonic()

    try:
        async with websockets.connect(uri, ping_interval=10, ping_timeout=10, max_size=16 * 1024 * 1024) as ws:
            elapsed = time.monotonic() - t_start
            print(f"    connected in {elapsed:.2f}s")

            # Send start
            await ws.send(json.dumps({"type": "start", "sample_rate": 16000, "speaker_count": "auto"}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            fallback = resp.get("fallback_mode", False)
            session = resp.get("session_id", "?")[:8]
            print(f"    start: fallback={fallback} session={session}")

            if not fallback:
                print("    NOTE: OSS is configured, test still valid but uses REST path")

            # Step 3: Send 3 seconds of speech-like audio
            pcm = gen_speech_like_pcm(3.0)
            chunk_size = 1600  # 100ms
            print(f"\n[3] Sending {len(pcm)} bytes PCM (3s speech-like audio)...")
            for i in range(0, len(pcm), chunk_size):
                await ws.send(pcm[i:i + chunk_size])
                await asyncio.sleep(0.005)
            print("    done")

            # Step 4: Send stop
            print(f"\n[4] Sending stop...")
            await ws.send(json.dumps({"type": "stop"}))

            # Step 5: Collect results
            print(f"\n[5] Collecting results...")
            t0 = time.monotonic()
            got_transcript = False
            got_error = False
            got_stopped = False

            while time.monotonic() - t0 < 60:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=30)
                except asyncio.TimeoutError:
                    print(f"    [{time.monotonic() - t0:.0f}s] TIMEOUT - no response")
                    break

                elapsed_total = time.monotonic() - t_start
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    print(f"    [{elapsed_total:.1f}s] raw: {msg[:100]}")
                    continue

                msg_type = data.get("type", "?")

                if msg_type == "processing":
                    print(f"    [{elapsed_total:.1f}s] processing: {data.get('message', '')}")
                elif msg_type == "transcript":
                    got_transcript = True
                    sentences = data.get("sentences", [])
                    speakers = data.get("speakers", [])
                    print(f"    [{elapsed_total:.1f}s] TRANSCRIPT: {len(sentences)} sentences, {len(speakers)} speaker(s)")
                    for s in sentences:
                        spk = s.get("speaker_id", "?")
                        text = s.get("text", "").strip()
                        begin = s.get("begin_ms", 0) / 1000
                        end = s.get("end_ms", 0) / 1000
                        if text:
                            print(f"      [{spk}] {begin:.1f}s-{end:.1f}s: {text[:80]}")
                elif msg_type == "chunk_queued":
                    print(f"    [{elapsed_total:.1f}s] chunk queued: index={data.get('chunk_index')}")
                elif msg_type == "chunk_submitted":
                    print(f"    [{elapsed_total:.1f}s] chunk submitted: index={data.get('chunk_index')}")
                elif msg_type == "error":
                    got_error = True
                    print(f"    [{elapsed_total:.1f}s] ERROR: {data.get('message', '')[:300]}")
                elif msg_type == "stopped":
                    got_stopped = True
                    print(f"    [{elapsed_total:.1f}s] stopped")
                    break
                else:
                    print(f"    [{elapsed_total:.1f}s] unknown type={msg_type}: {str(data)[:100]}")

            elapsed = time.monotonic() - t0
            print(f"\n[6] Summary:")
            print(f"    total time: {elapsed:.1f}s")
            print(f"    transcript: {'YES' if got_transcript else 'NO'}")
            print(f"    error: {'YES' if got_error else 'NO'}")
            print(f"    stopped: {'YES' if got_stopped else 'NO'}")

            # Step 6: Overall result
            print(f"\n{'=' * 70}")
            if got_transcript:
                print("RESULT: PASS - Transcription received!")
            elif got_stopped and not got_error:
                print("RESULT: PARTIAL - Stopped with no transcript (audio may not be speech-like enough)")
            elif got_error:
                print("RESULT: FAIL - Error occurred")
            else:
                print("RESULT: FAIL - No useful response")
            print('=' * 70)

    except websockets.exceptions.WebSocketException as e:
        print(f"\nFAIL: WebSocket connection error: {e}")
    except Exception as e:
        print(f"\nFAIL: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()


asyncio.run(main())
