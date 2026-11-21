(function () {
  // Set this to your Render backend URL in Step 2 (e.g. "https://clipsenic-worker.onrender.com")
  // Leaving it empty keeps honest mode active: no fake AI clips or simulated progress.
  const BACKEND_URL = window.CLIPSENIC_BACKEND_URL || '';

  let pollTimer = null;
  let activeVideoId = null;

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  function findUploadCardAnchor() {
    const form = document.getElementById('videoUploadForm');
    if (!form) return null;
    return form.closest('section, article, .card, .upload-card, div') || form;
  }

  function ensureSectionMounted() {
    let section = document.getElementById('cs-m2b-section');
    if (section) return section;

    section = document.createElement('section');
    section.id = 'cs-m2b-section';
    section.setAttribute('aria-label', 'Video Library and Generated Clips');
    section.innerHTML = `
      <div class="cs-m2b-header">
        <div>
          <h2 class="cs-m2b-title">Your Video Library</h2>
          <p class="cs-m2b-subtitle">Uploaded videos from Supabase Storage (<code>clips</code>) and generated 9:16 clips.</p>
        </div>
        <button type="button" id="csM2bRefreshBtn" class="cs-m2b-pill-btn">Refresh Library</button>
      </div>
      <div id="csM2bNotice" class="cs-m2b-banner" style="display:none;"></div>
      <div id="csM2bVideosGrid" class="cs-m2b-grid"></div>
      <div id="csM2bClipsZone" class="cs-m2b-clips-zone" style="display:none;">
        <div class="cs-m2b-header">
          <div>
            <h3 id="csM2bClipsHeading" class="cs-m2b-title" style="font-size:1.15rem;">Generated 9:16 Clips</h3>
            <p class="cs-m2b-subtitle">Preview vertical clips and export MP4 files.</p>
          </div>
        </div>
        <div id="csM2bClipsGrid" class="cs-m2b-grid"></div>
      </div>
    `;

    const anchor = findUploadCardAnchor();
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(section, anchor.nextSibling);
    } else {
      document.body.appendChild(section);
    }

    document.getElementById('csM2bRefreshBtn').addEventListener('click', loadVideoLibrary);
    return section;
  }

  function showNotice(message, type = 'warn') {
    const el = document.getElementById('csM2bNotice');
    if (!el) return;
    if (!message) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.className = `cs-m2b-banner ${type === 'info' ? 'info' : ''}`;
    el.textContent = message;
    el.style.display = 'block';
  }

  async function getSignedClipUrl(client, storagePath) {
    if (!storagePath) return null;
    const { data, error } = await client.storage.from('clips').createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async function downloadMp4(url, fileName) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName || 'clipsenic-9x16.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }

  async function loadClipsForVideo(video) {
    const client = window.clipSenicSupabase;
    const zone = document.getElementById('csM2bClipsZone');
    const grid = document.getElementById('csM2bClipsGrid');
    const heading = document.getElementById('csM2bClipsHeading');
    if (!client || !zone || !grid) return;

    activeVideoId = video.id;
    heading.textContent = `Clips for "${video.title || video.file_name || 'Video'}"`;
    zone.style.display = 'block';
    grid.innerHTML = '<p class="cs-m2b-subtitle">Loading clips...</p>';

    const { data: clips, error } = await client
      .from('cs_clips')
      .select('id, video_id, title, start_seconds, end_seconds, clip_score, storage_path, status, created_at')
      .eq('video_id', video.id)
      .order('clip_score', { ascending: false });

    if (error) {
      grid.innerHTML = `<div class="cs-m2b-banner">Could not load clips: ${escapeHtml(error.message)}</div>`;
      return;
    }

    if (!clips || clips.length === 0) {
      grid.innerHTML = '<p class="cs-m2b-subtitle">No clips generated for this video yet.</p>';
      return;
    }

    const signedUrls = await Promise.all(clips.map((c) => getSignedClipUrl(client, c.storage_path)));

    grid.innerHTML = '';
    clips.forEach((clip, idx) => {
      const url = signedUrls[idx];
      const status = (clip.status || 'pending').toLowerCase();
      const card = document.createElement('div');
      card.className = 'cs-m2b-card';
      card.innerHTML = `
        ${url
          ? `<video class="cs-m2b-clip-preview" controls playsinline preload="metadata" src="${escapeHtml(url)}"></video>`
          : `<div class="cs-m2b-clip-preview" style="display:flex;align-items:center;justify-content:center;color:#a1a1aa;font-size:0.85rem;">MP4 not ready</div>`
        }
        <div class="cs-m2b-card-top">
          <h4 class="cs-m2b-card-title">${escapeHtml(clip.title || 'Highlight Clip')}</h4>
          <span class="cs-m2b-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
        </div>
        <div class="cs-m2b-meta">
          <span>${formatTime(clip.start_seconds)} – ${formatTime(clip.end_seconds)}</span>
          ${clip.clip_score != null ? `<span>Score: ${escapeHtml(clip.clip_score)}</span>` : ''}
          <span>9:16</span>
        </div>
        <div class="cs-m2b-actions">
          <button type="button" class="cs-m2b-pill-btn primary cs-download-clip-btn" ${url ? '' : 'disabled'}>
            Export MP4
          </button>
        </div>
      `;

      const dlBtn = card.querySelector('.cs-download-clip-btn');
      if (dlBtn && url) {
        const safeTitle = (clip.title || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
        dlBtn.addEventListener('click', () => downloadMp4(url, `${safeTitle}_9x16.mp4`));
      }
      grid.appendChild(card);
    });
  }

  async function handleGenerateClips(video, btn) {
    const client = window.clipSenicSupabase;
    if (!client) return;

    if (!BACKEND_URL) {
      showNotice(
        'Backend worker is not connected yet. Deploy the Render Node.js + FFmpeg + Gemini API service in Step 2 and set window.CLIPSENIC_BACKEND_URL to run real AI highlight detection and 9:16 MP4 export.',
        'warn'
      );
      return;
    }

    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      showNotice('Please sign in first to generate clips.', 'warn');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Starting...';
    showNotice('Sending video to Render worker for AI highlight detection & 9:16 rendering...', 'info');

    try {
      const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/api/generate-clips`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ videoId: video.id })
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `Backend returned ${res.status}`);
      }

      activeVideoId = video.id;
      startPolling();
      await loadVideoLibrary();
    } catch (err) {
      showNotice(`Could not start clip generation: ${err.message}`, 'warn');
      btn.disabled = false;
      btn.textContent = 'Generate Clips';
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(loadVideoLibrary, 4000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function loadVideoLibrary() {
    ensureSectionMounted();
    const client = window.clipSenicSupabase;
    const grid = document.getElementById('csM2bVideosGrid');
    const clipsZone = document.getElementById('csM2bClipsZone');
    if (!client || !grid) return;

    const { data: { session } } = await client.auth.getSession();
    if (!session?.user) {
      stopPolling();
      showNotice('Sign in to view your uploaded videos and generated 9:16 clips.', 'info');
      grid.innerHTML = '';
      if (clipsZone) clipsZone.style.display = 'none';
      return;
    }

    const { data: videos, error } = await client
      .from('cs_videos')
      .select('id, title, file_name, storage_path, file_size, status, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      showNotice(`Failed to load videos: ${error.message}`, 'warn');
      return;
    }

    if (!BACKEND_URL) {
      showNotice(
        'Frontend Video Library is live. Real AI highlight detection and 9:16 MP4 export require connecting your Render backend (Step 2).',
        'info'
      );
    } else {
      showNotice('');
    }

    if (!videos || videos.length === 0) {
      stopPolling();
      grid.innerHTML = '<p class="cs-m2b-subtitle">No videos uploaded yet. Upload a video above to see it here.</p>';
      return;
    }

    const hasActiveJob = videos.some((v) => ['queued', 'processing'].includes((v.status || '').toLowerCase()));
    if (hasActiveJob) startPolling();
    else stopPolling();

    const signedUrls = await Promise.all(videos.map((v) => getSignedClipUrl(client, v.storage_path)));

    grid.innerHTML = '';
    videos.forEach((video, idx) => {
      const url = signedUrls[idx];
      const status = (video.status || 'uploaded').toLowerCase();
      const isBusy = status === 'queued' || status === 'processing';

      const card = document.createElement('div');
      card.className = 'cs-m2b-card';
      card.innerHTML = `
        ${url
          ? `<video class="cs-m2b-video-preview" controls playsinline preload="metadata" src="${escapeHtml(url)}"></video>`
          : `<div class="cs-m2b-video-preview" style="display:flex;align-items:center;justify-content:center;color:#a1a1aa;font-size:0.85rem;">Preview unavailable</div>`
        }
        <div class="cs-m2b-card-top">
          <h3 class="cs-m2b-card-title">${escapeHtml(video.title || video.file_name || 'Untitled Video')}</h3>
          <span class="cs-m2b-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
        </div>
        <div class="cs-m2b-meta">
          <span>${formatBytes(video.file_size)}</span>
          <span>${new Date(video.created_at).toLocaleDateString()}</span>
        </div>
        <div class="cs-m2b-actions">
          <button type="button" class="cs-m2b-pill-btn primary cs-gen-btn" ${isBusy ? 'disabled' : ''}>
            ${isBusy ? 'Processing...' : 'Generate Clips'}
          </button>
          <button type="button" class="cs-m2b-pill-btn cs-view-clips-btn">View Clips</button>
        </div>
      `;

      card.querySelector('.cs-gen-btn').addEventListener('click', (e) => handleGenerateClips(video, e.currentTarget));
      card.querySelector('.cs-view-clips-btn').addEventListener('click', () => loadClipsForVideo(video));
      grid.appendChild(card);

      if (activeVideoId && activeVideoId === video.id) {
        loadClipsForVideo(video);
      }
    });
  }

  function initMilestone2B() {
    ensureSectionMounted();
    const waitForClient = setInterval(() => {
      if (!window.clipSenicSupabase) return;
      clearInterval(waitForClient);
      window.clipSenicSupabase.auth.onAuthStateChange(() => loadVideoLibrary());
      loadVideoLibrary();
    }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMilestone2B);
  } else {
    initMilestone2B();
  }
})();
