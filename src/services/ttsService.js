// Text-to-speech (FEAT-081 / FEAT-107) using the offline Windows speech engine (Windows.Media.SpeechSynthesis,
// OneCore voices — includes Arabic voices such as "Microsoft Hoda" when the language pack is installed).
// Text is passed through a UTF-8 temp file, never on the command line.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AppError } from "../core/validation.js";
import { uid } from "../core/util.js";

const PS_COMMON = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
function Await($op, [Type]$t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
`;

const PS_LIST = PS_COMMON + String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$list = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; language = $_.Language; gender = [string]$_.Gender; id = $_.Id } }
$list | ConvertTo-Json -Compress
`;

const PS_SPEAK = String.raw`param([string]$TextFile, [string]$Voice, [string]$Out, [double]$Rate = 1.0, [double]$Pitch = 1.0)
$ErrorActionPreference = 'Stop'
` + PS_COMMON + String.raw`
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $Voice } | Select-Object -First 1
if (-not $v) { throw "voice-not-found" }
$synth.Voice = $v
$synth.Options.SpeakingRate = $Rate
$synth.Options.AudioPitch = $Pitch
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$size = [uint32]$stream.Size
[void](Await ($reader.LoadAsync($size)) ([uint32]))
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[IO.File]::WriteAllBytes($Out, $bytes)
`;

function runPs(scriptFile, args = [], timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, ...args], { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new AppError("PROVIDER", "err.ttsUnavailable", { message: e.message })); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new AppError("PROVIDER", err.includes("voice-not-found") ? "err.ttsVoice" : "err.ttsFailed", { stderr: err.slice(-1500) })); });
  });
}

export class TtsService {
  constructor({ paths, media }) {
    this.paths = paths;
    this.media = media;
    this.dir = path.join(paths.cache, "scripts");
    fs.mkdirSync(this.dir, { recursive: true });
    this.listFile = path.join(this.dir, "tts-list.ps1");
    this.speakFile = path.join(this.dir, "tts-speak.ps1");
    // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII correctly.
    fs.writeFileSync(this.listFile, "﻿" + PS_LIST, "utf8");
    fs.writeFileSync(this.speakFile, "﻿" + PS_SPEAK, "utf8");
    this.voicesCache = null;
  }

  available() { return process.platform === "win32"; }

  async voices() {
    if (!this.available()) return [];
    if (this.voicesCache) return this.voicesCache;
    const raw = (await runPs(this.listFile, [], 30_000)).trim();
    const parsed = raw ? JSON.parse(raw) : [];
    this.voicesCache = (Array.isArray(parsed) ? parsed : [parsed]).map((v) => ({ name: v.name, language: v.language, gender: v.gender }));
    return this.voicesCache;
  }

  /** Synthesize `text` and import the WAV into the project. Returns the media asset. */
  async synthesize(projectId, { text, voice, rate = 1, pitch = 1 }) {
    if (typeof text !== "string" || !text.trim()) throw new AppError("VALIDATION", "err.ttsText");
    if (text.length > 5000) throw new AppError("VALIDATION", "err.ttsTooLong", { max: 5000 });
    const voices = await this.voices();
    if (!voices.some((v) => v.name === voice)) throw new AppError("VALIDATION", "err.ttsVoice");
    const r = Math.min(6, Math.max(0.5, Number(rate) || 1)), p = Math.min(2, Math.max(0, Number(pitch) || 1));
    const id = uid();
    const txt = path.join(this.dir, `${id}.txt`);
    const out = path.join(this.paths.media, `tts-${id}.wav`);
    fs.writeFileSync(txt, text, "utf8");
    try {
      await runPs(this.speakFile, ["-TextFile", txt, "-Voice", voice, "-Out", out, "-Rate", String(r), "-Pitch", String(p)]);
    } finally { fs.rmSync(txt, { force: true }); }
    const { imported, errors } = await this.media.importFiles(projectId, [out], { origin: "tts" });
    if (!imported.length) throw new AppError("PROVIDER", "err.ttsFailed", { errors });
    return imported[0];
  }
}
