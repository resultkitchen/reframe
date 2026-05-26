import os, httpx, ormsgpack, pathlib

# Fish Audio s2-pro — DOCUMENTED tags only (catalog from emotions.md).
# Rules:  tags at sentence start  ·  max 1 primary emotion per sentence
# [break]≈0.4s · [long-break]≈1s · CAPS = word stress · periods = staccato
SCRIPT = """[resigned] Hour three. With Claude. The cursor blinks. [bored] You type. You wait. You preview. [frustrated] Another. [break] Broken. [break] Button. [break] You type again.

[long-break] [robotic monotone deadpan] Bip-pi-ty. [break] Boop. [break] Bip-pi-ty. [break] Boop. [break] [robotic glitched mechanical] BIP. [break] PI. [break] TY. [break] BOOP.

[long-break] [disgusted] What's shipping — [break] is a Frankenstein. [contemptuous] Buttons that LIE. Functions the model HALLUCINATED out of thin air. Pages stitched together with imports that don't EXIST.

[break] [resigned] The vibe-coding hangover. [frustrated] And it is — [break] COMPLETELY — [break] needless.

[long-break] [determined] Here's why. [confident] Claude Opus? [break] About forty-eight tokens a second. [curious] GPT-5? [break] Seventy. [excited] Gemini 3 Pro doubles that. [break] One hundred thirty-five.

[break] [proud] And Gemini Flash-Lite? [break] Over three hundred thirty. [excited] SEVEN times faster than Opus.

[break] [disdainful] That's your speed budget. [break] Sitting on the table.

[long-break] [determined] Reframe USES it. [proud] We fan out THIRTY to a HUNDRED specialized agents across your repo. One. [break] Per. [break] Screen.

[break] [sarcastic] Each one gets a small, focused context window. [break] Small enough — [break] the model doesn't have to be a GENIUS — [break] to follow instructions.

[break] [confident] NO million-token soup. [break] NO amnesia.

[long-break] [excited] Pair Reframe with a Gemini model — [break] and you get a full QA pass and refactor of your WHOLE SaaS. [proud] In TWENTY minutes. [break] Or less.

[break] [curious] Want to use Claude? [break] OpenAI? [sarcastic] The old geezers still work. [confident] Reframe is LLM-agnostic.

[long-break] [proud] Open source. [calm] Pull it from github dot com. [break] Slash result kitchen. [break] Slash rebuild dash pipeline.

[break] [compassionate] Day-one vibe coder, [break] or twenty-year engineer. [break] Point it at your app.

[long-break] [angry intense low growl] KILL. [long-break] THE. [long-break] BIP-PI-TY. [long-break] BOOP.

[long-break] [curious] So. [break] What are you building right now? [hopeful] Drop the link below. [grateful] I'll send you the exact prompt to get going."""

KEY = os.environ.get("FISH_AUDIO_API_KEY")
if not KEY:
    raw = open(os.path.expanduser("~/.credentials/master.env")).read()
    for line in raw.splitlines():
        if line.startswith("FISH_AUDIO_API_KEY="):
            KEY = line.split("=", 1)[1].strip()
            break

payload = {
    "text": SCRIPT,
    "reference_id": "59e9dc1cb20c452584788a2690c80970",
    "format": "mp3",
    "mp3_bitrate": 192,
    "chunk_length": 150,       # smaller = more inflection variety, less monotone
    "normalize": True,
    "latency": "balanced",     # more processing per chunk = more dynamic prosody
}

out = pathlib.Path(__file__).parent / "audio" / "narration.mp3"
out.parent.mkdir(exist_ok=True)

print(f"POST fish.audio (s2-pro, ref 59e9...0970, {len(SCRIPT)} chars)")
with httpx.Client(timeout=180) as c:
    r = c.post(
        "https://api.fish.audio/v1/tts",
        content=ormsgpack.packb(payload),
        headers={
            "authorization": f"Bearer {KEY}",
            "content-type": "application/msgpack",
            "model": "s2-pro",
        },
    )
    r.raise_for_status()
    out.write_bytes(r.content)
print(f"wrote {out} ({len(r.content):,} bytes)")
