#!/usr/bin/env node
/**
 * Fetches every asset from Mux and writes public/assets.json.
 *
 * Runs inside the GitHub Actions workflow on a schedule. MUX_TOKEN_ID and
 * MUX_TOKEN_SECRET come from encrypted repo secrets (Settings > Secrets and
 * variables > Actions) — they are never written to this file or to the
 * JSON output, only held in the environment for the life of this process.
 *
 * Use a READ ONLY Mux access token for this. It only ever calls GET endpoints.
 */
const fs = require('fs');
const path = require('path');

const TOKEN_ID = process.env.MUX_TOKEN_ID;
const TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;

if (!TOKEN_ID || !TOKEN_SECRET) {
  console.error('Missing MUX_TOKEN_ID / MUX_TOKEN_SECRET environment variables.');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  console.error('Needs Node.js 18+ for built-in fetch.');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

// Same multi-scene preview idea as the catalogue page, so this file can feed it directly.
const PREVIEW_SCENE_POSITIONS = [0.15, 0.5, 0.82];
const PREVIEW_SCENE_DURATION = 2;
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'assets.json');

async function fetchAllAssets() {
  let assets = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const res = await fetch(`https://api.mux.com/video/v1/assets?limit=${limit}&page=${page}`, {
      headers: { Authorization: AUTH_HEADER }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Mux API error ${res.status}: ${body}`);
    }
    const json = await res.json();
    const data = json.data || [];
    assets = assets.concat(data);
    if (data.length < limit) break;
    page++;
  }
  return assets;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildPreviewUrls(playbackId, duration) {
  const dur = duration || 20;
  return PREVIEW_SCENE_POSITIONS.map(pct => {
    const start = clamp(dur * pct, 0, Math.max(0, dur - PREVIEW_SCENE_DURATION));
    const end = clamp(start + PREVIEW_SCENE_DURATION, 0, dur);
    return `https://image.mux.com/${playbackId}/animated.webp?start=${start.toFixed(1)}&end=${end.toFixed(1)}&width=480&fps=12`;
  });
}

function posterUrl(playbackId, duration) {
  const t = duration ? (duration * 0.35).toFixed(1) : 1;
  return `https://image.mux.com/${playbackId}/thumbnail.webp?time=${t}&width=640`;
}

function pickPlaybackId(asset) {
  if (!asset.playback_ids || !asset.playback_ids.length) return null;
  const pub = asset.playback_ids.find(p => p.policy === 'public');
  return (pub || asset.playback_ids[0]).id;
}

function pickResolutionLabel(asset) {
  // resolution_tier already comes back as "1080p" / "1440p" / "2160p" etc.
  if (asset.resolution_tier) return asset.resolution_tier;
  // Fallback for older assets that might not have resolution_tier set:
  // derive it from the video track's stored height.
  const videoTrack = (asset.tracks || []).find(t => t.type === 'video');
  if (videoTrack && videoTrack.max_height) return `${videoTrack.max_height}p`;
  return null;
}

async function main() {
  console.log('Fetching assets from Mux...');
  const raw = await fetchAllAssets();
  console.log(`Found ${raw.length} total assets.`);

  const videos = raw
    .filter(a => a.status === 'ready' && pickPlaybackId(a))
    .map(a => {
      const playbackId = pickPlaybackId(a);
      // Mux returns created_at as a string of unix seconds (e.g. "1609869152"),
      // not an ISO date — convert it properly so sorting actually works.
      const createdAtMs = a.created_at ? Number(a.created_at) * 1000 : null;
      return {
        id: a.id,
        playbackId,
        title: a.passthrough || (a.meta && a.meta.title) || a.id,
        duration: a.duration || null,
        createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
        aspectRatio: a.aspect_ratio || null,
        resolution: pickResolutionLabel(a),
        poster: posterUrl(playbackId, a.duration),
        previews: buildPreviewUrls(playbackId, a.duration)
      };
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); // newest first

  const output = {
    // Always changes, so there is always something to commit — this is what
    // keeps the scheduled workflow from being auto-disabled after 60 days
    // of "inactivity." Every successful run IS activity.
    generatedAt: new Date().toISOString(),
    count: videos.length,
    videos
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${videos.length} videos to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
