#!/usr/bin/env python3
"""Process a public Instagram/YouTube video and email a factual analysis.
Requires yt-dlp, ffmpeg, ffprobe and OPENAI_API_KEY, RESEND_API_KEY, CHUCK_INBOX_EMAIL.
Runs in a disposable GitHub Actions runner; does not touch the Telegram webhook.
"""
import base64, json, os, pathlib, re, subprocess, tempfile, urllib.parse, urllib.request

ALLOWED = {"instagram.com", "www.instagram.com", "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"}
MAX_SECONDS = 600
MAX_BYTES = 150 * 1024 * 1024

def post_json(url, body, headers):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type":"application/json", **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.load(response)

def validate_url(raw):
    url = urllib.parse.urlsplit(raw.strip())
    if url.scheme != "https" or url.hostname not in ALLOWED or url.username or url.password or url.port:
        raise ValueError("Only HTTPS public Instagram/YouTube URLs are supported")
    return raw.strip()

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def openai_transcribe(audio):
    boundary = "chuckaudio" + os.urandom(8).hex()
    data = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-4o-mini-transcribe\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n").encode()
    data += audio.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=data,
        headers={"Authorization":"Bearer "+os.environ["OPENAI_API_KEY"],"Content-Type":"multipart/form-data; boundary="+boundary}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as response:
        return json.load(response).get("text","")

def main():
    source = validate_url(os.environ["SOURCE_URL"])
    with tempfile.TemporaryDirectory() as temp:
        folder = pathlib.Path(temp)
        template = str(folder / "media.%(ext)s")
        run("yt-dlp", "--no-playlist", "--max-filesize", "150M", "--socket-timeout", "25",
            "--retries", "2", "--merge-output-format", "mp4", "-o", template, source)
        candidates = [p for p in folder.glob("media.*") if p.is_file()]
        if len(candidates) != 1: raise RuntimeError("Expected exactly one video file; carousel is not yet supported")
        media = candidates[0]
        if media.stat().st_size > MAX_BYTES: raise ValueError("Video exceeds 150 MB")
        duration = float(json.loads(run("ffprobe","-v","error","-show_entries","format=duration","-of","json",str(media)))["format"]["duration"])
        if duration > MAX_SECONDS: raise ValueError("Video exceeds 10 minutes")
        audio = folder / "audio.mp3"
        run("ffmpeg","-y","-i",str(media),"-vn","-ac","1","-ar","16000","-b:a","48k",str(audio))
        transcript = openai_transcribe(audio)
        frames = []
        for idx, sec in enumerate(sorted(set([max(0, duration * i / 5) for i in range(1,5)]))):
            path = folder / f"frame{idx}.jpg"
            run("ffmpeg","-y","-ss",str(sec),"-i",str(media),"-frames:v","1","-vf","scale=768:-2","-q:v","5",str(path))
            frames.append({"type":"input_text","text":f"Frame at {sec:.1f} seconds"})
            frames.append({"type":"input_image","image_url":"data:image/jpeg;base64,"+base64.b64encode(path.read_bytes()).decode()})
        prompt = ("Analyse the sampled video frames and transcript in Russian. Describe what is actually visible, "
                  "read onscreen text where legible, summarize techniques and ideas, practical uses for property "
                  "development and content production, score 1-10 with reasons, and next steps. "
                  "Clearly distinguish confirmed observations from inference. State that only sampled frames were seen. "
                  "Transcript:\n"+transcript[:25000])
        result = post_json("https://api.openai.com/v1/responses",
            {"model":"gpt-4.1-mini","input":[{"role":"user","content":[{"type":"input_text","text":prompt},*frames]}],"max_output_tokens":1400},
            {"Authorization":"Bearer "+os.environ["OPENAI_API_KEY"]})
        analysis = "\n".join(part.get("text","") for output in result.get("output",[]) for part in output.get("content",[]) if part.get("type")=="output_text")
        if not analysis: raise RuntimeError("Model returned no text")
        body = f"Chuck Inbox video analysis\nSource: {source}\nDuration: {duration:.1f}s\nFrames sampled: {len(frames)//2}\n\nANALYSIS:\n{analysis}\n\nTRANSCRIPT:\n{transcript[:30000]}"
        post_json("https://api.resend.com/emails",{"from":"Chuck Inbox <onboarding@resend.dev>","to":[os.environ["CHUCK_INBOX_EMAIL"]],
            "subject":"[Chuck Inbox Analysis] "+source[:100],"text":body},
            {"Authorization":"Bearer "+os.environ["RESEND_API_KEY"]})
        print("Analysis delivered; no video retained")

if __name__ == "__main__":
    main()
