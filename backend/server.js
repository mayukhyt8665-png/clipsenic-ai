
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const app = express();
const execFileAsync = promisify(execFile);

app.use(cors({
  origin: "https://clipsenic-ai.vercel.app"
}));
app.use(express.json({ limit: "1mb" }));

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY
} = process.env;

const configReady =
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  SUPABASE_SERVICE_ROLE_KEY &&
  GEMINI_API_KEY &&
  ffmpegPath;

const authClient = configReady
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    })
  : null;

const admin = configReady
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    })
  : null;

const ai = configReady
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const activeJobs = new Set();

app.get("/", (req, res) => {
  res.json({
    name: "ClipSenic AI Backend",
    status: "running",
    message: "Backend connected successfully!"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    configured: Boolean(configReady)
  });
});

async function processVideo(video, userId) {
  const workDir = await mkdtemp(path.join(tmpdir(), "clipsenic-"));
  let geminiFileName = null;

  try {
    await admin
      .from("cs_videos")
      .update({ status: "processing" })
      .eq("id", video.id)
      .eq("user_id", userId);

    const { data: signedFile, error: signedUrlError } = await admin.storage
  .from("clips")
  .createSignedUrl(video.storage_path, 600);

if (signedUrlError || !signedFile?.signedUrl) {
  throw new Error("Could not create a source video download link.");
}

const sourceResponse = await fetch(signedFile.signedUrl);

if (!sourceResponse.ok || !sourceResponse.body) {
  throw new Error("Could not download the source video.");
}

const inputPath = path.join(workDir, "input-video");

await pipeline(
  Readable.fromWeb(sourceResponse.body),
  createWriteStream(inputPath)
);

    

    const uploadedFile = await ai.files.upload({
      file: inputPath,
      config: {
        mimeType: video.mime_type || "video/mp4"
      }
    });

    geminiFileName = uploadedFile.name;

    let readyFile = uploadedFile;

    for (let i = 0; i < 30; i++) {
      if (readyFile.state === "ACTIVE") break;
      if (readyFile.state === "FAILED") {
        throw new Error("Gemini could not process this video.");
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      readyFile = await ai.files.get({ name: geminiFileName });
    }

    if (readyFile.state !== "ACTIVE") {
      throw new Error("Video analysis timed out.");
    }


    let analysis;
const maxRetries = 3;

for (let attempt = 0; attempt <= maxRetries; attempt++) {
  try {
    analysis = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: createUserContent([
        createPartFromUri(readyFile.uri, readyFile.mimeType),
        `Find up to 3 interesting, exciting or funny moments suitable
        for short gaming videos.

        Return ONLY a JSON array, no markdown.
        Each item must contain:
        "title": short clip title,
        "start": start time in seconds,
        "end": end time in seconds,
        "score": integer from 1 to 100.

        Each clip should be 15 to 45 seconds long.
        Do not invent timestamps. Only select moments visible in the video.
        Example:
        [{"title":"Amazing moment","start":30,"end":55,"score":90}]`
      ])
    });

    break;
  } catch (error) {
    const message = String(error.message || error);
    const temporaryError =
      /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(message);

    if (!temporaryError || attempt === maxRetries) {
      throw error;
    }

    const delay = [2000, 5000, 10000][attempt];
    console.log(`Gemini temporary error. Retry ${attempt + 1} in ${delay / 1000}s.`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

    let raw = (analysis.text || "").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

    const firstBracket = raw.indexOf("[");
    const lastBracket = raw.lastIndexOf("]");

    if (firstBracket < 0 || lastBracket < firstBracket) {
      throw new Error("AI did not return valid clip timestamps.");
    }

    const suggestions = JSON.parse(
      raw.slice(firstBracket, lastBracket + 1)
    );

    // Preserve clips from previous interrupted processing attempts.
const { data: existingClips, error: existingClipsError } = await admin
  .from("cs_clips")
  .select("start_seconds,end_seconds")
  .eq("video_id", video.id)
  .eq("user_id", userId);

if (existingClipsError) {
  throw new Error("Could not check previously saved clips.");
}

const savedClips = existingClips || [];
const remainingSlots = Math.max(0, 3 - savedClips.length);

const clips = suggestions
  .filter(item =>
    typeof item.start === "number" &&
    typeof item.end === "number" &&
    item.start >= 0 &&
    item.end > item.start &&
    item.end - item.start >= 15 &&
    item.end - item.start <= 45 &&
    (!video.duration_seconds || item.end <= video.duration_seconds) &&
    !savedClips.some(saved =>
      Math.abs(Number(saved.start_seconds) - item.start) < 2 &&
      Math.abs(Number(saved.end_seconds) - item.end) < 2
    )
  )
  .slice(0, remainingSlots);

if (!clips.length && savedClips.length === 0)  {
      throw new Error("No suitable highlights were found.");
    }

    for (const clip of clips) {
      const clipId = randomUUID();
      const outputPath = path.join(workDir, `${clipId}.mp4`);
      const storagePath = `${userId}/clips/${video.id}/${clipId}.mp4`;

      await execFileAsync(ffmpegPath, [
        "-y",
        "-ss", String(clip.start),
        "-i", inputPath,
        "-t", String(clip.end - clip.start),
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-threads", "1",
        "-crf", "26",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath
      ], { timeout: 180000 });

      const outputBuffer = await readFile(outputPath);

      const { error: uploadError } = await admin.storage
        .from("clips")
        .upload(storagePath, outputBuffer, {
          contentType: "video/mp4",
          upsert: false
        });

      if (uploadError) {
        throw new Error("Could not save a generated clip.");
      }

      const { error: insertError } = await admin
        .from("cs_clips")
        .insert({
          id: clipId,
          video_id: video.id,
          user_id: userId,
          title: String(clip.title || "AI Highlight").slice(0, 150),
          start_seconds: clip.start,
          end_seconds: clip.end,
          clip_score: Math.min(100, Math.max(0, Number(clip.score) || 50)),
          storage_path: storagePath,
          status: "complete"
        });

      if (insertError) {
        await admin.storage.from("clips").remove([storagePath]);
        throw new Error("Could not save clip information.");
      }
    }

    await admin
      .from("cs_videos")
      .update({ status: "complete" })
      .eq("id", video.id)
      .eq("user_id", userId);

  } catch (error) {
    console.error("Video processing failed:", error.message);

    await admin
      .from("cs_videos")
      .update({ status: "failed" })
      .eq("id", video.id)
      .eq("user_id", userId);

  } finally {
    if (geminiFileName) {
      try {
        await ai.files.delete({ name: geminiFileName });
      } catch (error) {
        console.error("Gemini temporary file cleanup failed.");
      }
    }

    await rm(workDir, { recursive: true, force: true });
    activeJobs.delete(video.id);
  }
}

app.post("/api/generate-clips", async (req, res) => {
  try {
    if (!configReady) {
      return res.status(503).json({
        error: "Backend environment is not fully configured."
      });
    }

    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    const {
      data: { user },
      error: authError
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const videoId = req.body?.videoId;

    if (typeof videoId !== "string" || videoId.length > 100) {
      return res.status(400).json({ error: "Invalid video ID." });
    }

    if (activeJobs.has(videoId)) {
      return res.status(409).json({ error: "This video is already processing." });
    }

    const { data: video, error: videoError } = await admin
      .from("cs_videos")
      .select("id,user_id,title,storage_path,mime_type,duration_seconds,status")
      .eq("id", videoId)
      .eq("user_id", user.id)
      .single();

    if (videoError || !video) {
      return res.status(404).json({ error: "Video not found." });
    }

    if (!video.storage_path ||
        !video.storage_path.startsWith(`${user.id}/`)) {
      return res.status(403).json({ error: "Video storage access denied." });
    }

    

    activeJobs.add(videoId);

    await admin
      .from("cs_videos")
      .update({ status: "queued" })
      .eq("id", videoId)
      .eq("user_id", user.id);

    res.status(202).json({
      success: true,
      message: "Video accepted for processing."
    });

    processVideo(video, user.id).catch(error => {
      console.error("Background processing error:", error.message);
      activeJobs.delete(videoId);
    });

  } catch (error) {
    console.error("Generate request failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not start video processing." });
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipSenic backend running on port ${PORT}`);

  if (configReady) {
    admin
      .from("cs_videos")
      .update({ status: "failed" })
      .in("status", ["queued", "processing"])
      .select("id")
      .then(({ data, error }) => {
        if (error) {
          console.error("Interrupted job recovery failed:", error.message);
          return;
        }

        if (data?.length) {
          console.log(`Recovered ${data.length} interrupted video job(s).`);
        }
      })
      .catch(error => {
        console.error("Interrupted job recovery failed:", error.message);
      });
  }
});
