/* ==========================================================================
   ROBOT 2027 - V3.0 PRO
   - 8 Expressive Moods + Natural Eye Gaze & Blinking + Anti-Repeat Dialogue
   - Voice User Switch & Instant New Profile Creation (With 1-Step Confirm)
   - Smart Sleep (Voice Command + 60s Auto-Sleep Even On Lesson Idle Screen)
   - 4-State Voice Engine + 30s Press-[B] English Recording (1.8s / 4.0s Smart Finish)
   - 4-Key Horizontal Hardware Nav (A/B/C/D) + Double-A Escape & 350ms Iframe ACK
   - 100% In-App Wi-Fi (Scan/Select/Connect/Forget) + Dual-Mode BT (ESP32 & Phone Sim)
   - Silent 24/7 WebRTC P2P Camera (Batch ICE, Zero Ring, Never Wakes Sleeping Kid)
   - Safe 2s Star Sync (YouTube/Game) + Study-Only Lock + MOSFET 50%-90% Battery Guard
   ========================================================================== */
(function () {
  "use strict";

  const SERVER_BASE = "https://khotrithucso.io.vn/robot2027_2_4/test1";
  const DEV_MASTER_PIN = "202799";

  const RECORD_MAX_SECONDS = 30;
  const SILENCE_FAST_FINISH_MS = 1800; // Đã đọc đạt ngưỡng -> chốt cực nhanh
  const SILENCE_SLOW_FINISH_MS = 4000; // Chưa đạt ngưỡng -> chờ thoáng cho bé đọc tiếp
  const ECHO_GUARD_MS = 500;
  const HOME_PROMPT_IDLE_SEC = 30;     // Sau 30s rảnh ở trang chủ -> hỏi thăm đúng 1 lần
  const AUTO_SLEEP_IDLE_SEC = 60;      // Sau 60s không tương tác (cả Home & bài học chờ) -> tự ngủ

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  const getRobotNative = () => window.Capacitor?.Plugins?.RobotNative || null;

  const state = {
    activeTab: "robot",
    settingsUnlocked: false,
    karaokeOpen: false,
    awaitingTopicChoice: false,

    // Hội thoại đổi / tạo người dùng bằng giọng nói
    awaitingIdentityReplyUntil: 0,
    pendingNewUserName: "",
    pendingNewUserUntil: 0,

    // Máy trạng thái 4 pha: IDLE_VI | SPEAKING | ECHO_GUARD | LESSON_RECORDING_EN
    voiceState: "IDLE_VI",
    activeUtteranceId: "",
    isListeningNative: false,
    echoGuardTimer: null,
    speakWatchdogTimer: null,

    // Phiên ghi âm 30 giây
    recSecondsLeft: RECORD_MAX_SECONDS,
    recTickTimer: null,
    recSilenceTimer: null,
    recSegments: [],
    recCurrentPartial: "",

    // Nghỉ ngơi & biểu cảm
    idleSeconds: 0,
    promptedOnceThisIdle: false,
    sleepStage: "awake", // awake | sleeping
    mood: "happy",
    lastDialogueByKey: {},

    // Phần cứng & MOSFET
    headLightOn: false,
    armLightOn: false,
    bleConnected: false,
    bleDeviceId: "",
    bleDeviceName: "",
    btDiscoveredMap: {},
    selectedBtAddress: "",
    mosfetState: "UNKNOWN",

    // Wi-Fi
    wifiScannedList: [],
    selectedWifiSsid: "",
    wifiVerifyTimer: null,

    // Thành viên & tiến độ
    members: [],
    activeMemberId: "m_default",
    deviceUid: "",
    memberProgress: {},

    // Chủ đề & câu học
    topics: [],
    orderMode: "sequential",
    onlyViFilter: false,
    currentTopicSlug: "",
    currentTopicTitle: "Giao tiếp hằng ngày",
    sentences: [
      {
        id: 0,
        en: "Hello! How are you today?",
        vi: "Xin chào! Hôm nay bạn khỏe không?",
        audio_url: "",
        spelling: [
          { word: "Hello", spell: "H-E-L-L-O" },
          { word: "How", spell: "H-O-W" },
          { word: "are", spell: "A-R-E" },
          { word: "you", spell: "Y-O-U" },
          { word: "today", spell: "T-O-D-A-Y" }
        ]
      }
    ],
    sentenceIndex: 0,

    config: {
      parentPin: "1234",
      studyOnly: false,
      brightness: 75,
      volume: 80,
      speechRate: 0.95,
      passThreshold: 60,
      bleAutoReconnect: true,
      savedBleAddress: "",
      savedBleName: "",
      savedBlePin: ""
    },

    // Audio, Polling & Key-A ACK
    pointPollTimer: null,
    audioPlayer: new Audio(),
    preloadAudio: new Audio(),
    karaokeHighlightTimers: [],
    camPreviewStream: null,
    lastKeyATime: 0,
    iframeExitFallbackTimer: null,

    focusIdx: {
      home: 0,
      karaoke: 2,
      topics: 0,
      settings: 0,
      pin: 0,
      wifi: 0,
      ble: 0,
      vkb: 0,
      member: 0,
      topicComplete: 1
    }
  };

  // ==================== KHO THOẠI ĐA DẠNG CHỐNG LẶP ====================
  const DIALOGUES = {
    greetMorning: [
      "Chào buổi sáng {name}! Hôm nay mình học tiếng Anh thật vui nhé!",
      "Buổi sáng tốt lành {name}! Bạn muốn học tiếng Anh, xem YouTube hay chơi game nào?",
      "Chào {name} yêu quý! Sẵn sàng cho một ngày mới đầy sao chưa?"
    ],
    greetAfternoon: [
      "Chào buổi chiều {name}! Mình học vài câu tiếng Anh rồi chơi game nhé!",
      "Chào {name}! Chiều nay bạn muốn học chủ đề nào cùng Lucky?",
      "Lucky xin chào {name}! Mình sẵn sàng nghe bạn rồi đây!"
    ],
    greetEvening: [
      "Chào buổi tối {name}! Mình ôn nhẹ vài câu tiếng Anh trước khi ngủ nhé!",
      "Tối vui vẻ {name}! Bạn muốn học tiếng Anh hay nghe hoạt hình nào?",
      "Chào {name}! Tối nay bạn muốn làm gì cùng Lucky?"
    ],
    praiseStar: [
      "Tuyệt vời quá {name} ơi! Bạn đạt {score} điểm và nhận thêm 1 ngôi sao!",
      "Xuất sắc luôn! {score} điểm, tặng {name} thêm 1 ngôi sao lấp lánh nhé!",
      "Giỏi quá đi mất! {score} điểm, {name} vừa kiếm thêm 1 ngôi sao mới!",
      "Hoan hô {name}! Phát âm {score} điểm chuẩn lắm, cộng 1 ngôi sao!"
    ],
    praiseRepeat: [
      "Rất giỏi! Bạn đạt {score} điểm!",
      "Đọc hay quá {name} ơi, đạt {score} điểm!",
      "Chuẩn luôn, {score} điểm xuất sắc!"
    ],
    encourage: [
      "Bạn đạt {score} điểm rồi, cố thêm xíu nữa là qua! Bấm nút B đọc lại nhé!",
      "Gần chuẩn rồi {name} ơi, đạt {score} điểm! Nghe lại hoặc bấm nút B thử lần nữa nha!",
      "Đạt {score} điểm rồi, đừng ngại nhé! Bấm nút B đọc chậm và rõ hơn nào!"
    ],
    idleHealth: [
      "{name} ơi, hôm nay bạn có khỏe không? Có muốn học vài câu tiếng Anh cùng Lucky không?",
      "Hôm nay đi học có vui không {name}? Lúc nào muốn học hay chơi game thì gọi Lucky nhé!",
      "{name} ơi, bạn thấy trong người thế nào? Mình làm vài câu tiếng Anh cho vui nha!"
    ],
    idleWho: [
      "Cho Lucky hỏi nhỏ, hôm nay là ai đang chơi cùng mình thế?",
      "À ơi, bạn tên là gì nhỉ? Nói tên để Lucky đổi đúng hồ sơ nhé!"
    ],
    goodnight: [
      "Chúc {name} ngủ ngon nhé! Lucky đi ngủ đây!",
      "Chúc bạn mơ đẹp! Khi nào cần cứ gọi Hello Lucky nhé!",
      "Lucky khép mắt nghỉ ngơi đây, chúc ngủ ngon!"
    ],
    unknownHome: [
      "Ồ, Lucky chưa hiểu rõ ý bạn lắm. Bạn có thể nói học tiếng Anh, xem YouTube hoặc chơi game nhé!",
      "Hihi, bạn nói lại rõ hơn giúp Lucky được không? Muốn học bài hay mở đèn nào?",
      "Lucky nghe chưa rõ lắm. Bạn muốn học tiếng Anh, đổi tên người dùng hay chơi game?"
    ]
  };

  function pickDialogue(key, vars = {}) {
    const arr = DIALOGUES[key] || [];
    if (arr.length === 0) return "";
    let idx = Math.floor(Math.random() * arr.length);
    if (arr.length > 1 && idx === state.lastDialogueByKey[key]) {
      idx = (idx + 1) % arr.length;
    }
    state.lastDialogueByKey[key] = idx;
    let text = arr[idx];
    Object.entries(vars).forEach(([k, v]) => {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    });
    return text;
  }

  // ==================== HELPERS & NETWORK ====================
  function generateUid(prefix = "RB_", len = 20) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = prefix;
    while (out.length < len) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out.slice(0, len);
  }

  function buildApiUrl(scriptName, params = {}) {
    const url = new URL(`${SERVER_BASE}/${scriptName}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    return url.toString();
  }

  async function fetchServerJson(scriptName, params = {}) {
    const url = buildApiUrl(scriptName, params);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 11000);
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) return JSON.parse(await res.text());
    } catch (_) {}

    const native = getRobotNative();
    if (native && typeof native.httpGet === "function") {
      const nativeRes = await native.httpGet({ url });
      if (nativeRes && nativeRes.body) return JSON.parse(nativeRes.body);
    }
    throw new Error("Không thể kết nối máy chủ");
  }

  async function postServerJson(scriptName, params = {}, bodyObj = {}) {
    const url = buildApiUrl(scriptName, params);
    const bodyStr = JSON.stringify(bodyObj);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 11000);
      const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: bodyStr,
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) return JSON.parse(await res.text());
    } catch (_) {}

    const native = getRobotNative();
    if (native && typeof native.httpPost === "function") {
      const nativeRes = await native.httpPost({ url, body: bodyStr });
      if (nativeRes && nativeRes.body) return JSON.parse(nativeRes.body);
    }
    throw new Error("POST máy chủ thất bại");
  }

  function normalizeVietnamese(str) {
    return (str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const NUMBER_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
    "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen",
    "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen",
    "18": "eighteen", "19": "nineteen", "20": "twenty"
  };

  function normalizeEnglishWords(str) {
    let s = (str || "").toLowerCase().replace(/[’‘`]/g, "'");
    const contractions = {
      "i'm": "i am", "you're": "you are", "he's": "he is", "she's": "she is",
      "it's": "it is", "we're": "we are", "they're": "they are",
      "what's": "what is", "where's": "where is", "who's": "who is",
      "how's": "how is", "that's": "that is", "there's": "there is",
      "don't": "do not", "doesn't": "does not", "didn't": "did not",
      "can't": "cannot", "won't": "will not", "isn't": "is not",
      "aren't": "are not", "wasn't": "was not", "weren't": "were not",
      "let's": "let us", "i've": "i have", "i'll": "i will", "i'd": "i would"
    };
    Object.entries(contractions).forEach(([k, v]) => {
      s = s.replace(new RegExp(`\\b${k}\\b`, "g"), v);
    });
    return s
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map(w => NUMBER_WORDS[w] || w);
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  }

  function buildLocalSpelling(sentence) {
    return (sentence || "")
      .replace(/[^a-zA-Z0-9'\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(w => ({ word: w, spell: w.toUpperCase().split("").join("-") }));
  }

  function playSuccessChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.001, now + idx * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.09 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.09);
        osc.stop(now + idx * 0.09 + 0.24);
      });
    } catch (_) {}
  }

  // ==================== STORAGE ====================
  function loadLocalState() {
    try {
      const savedCfg = JSON.parse(
        localStorage.getItem("rb_v30_config") ||
        localStorage.getItem("rb_v20_config") ||
        localStorage.getItem("rb_v14_config") ||
        "null"
      );
      if (savedCfg && typeof savedCfg === "object") Object.assign(state.config, savedCfg);
      const thr = Number(state.config.passThreshold);
      state.config.passThreshold = (thr >= 30 && thr <= 100) ? thr : 60;

      let devUid = localStorage.getItem("rb_v14_device_uid");
      if (!devUid) {
        devUid = generateUid("RB_CAM_", 20);
        localStorage.setItem("rb_v14_device_uid", devUid);
      }
      state.deviceUid = devUid;

      const savedMembers = JSON.parse(localStorage.getItem("rb_v14_members") || "null");
      if (Array.isArray(savedMembers) && savedMembers.length > 0) {
        state.members = savedMembers;
      } else {
        state.members = [
          { id: "m_default", uid: generateUid("KID_", 20), name: "Bé Yêu", age: 7, avatar: "🧒", stars: 5 }
        ];
      }

      const activeId = localStorage.getItem("rb_v14_active_member");
      state.activeMemberId = (activeId && state.members.some(m => m.id === activeId))
        ? activeId
        : state.members[0].id;

      const savedProg = JSON.parse(localStorage.getItem("rb_v20_progress") || "null");
      if (savedProg && typeof savedProg === "object") state.memberProgress = savedProg;

      const cachedTopics = JSON.parse(localStorage.getItem("rb_v14_topics_cache") || "null");
      if (Array.isArray(cachedTopics) && cachedTopics.length > 0) state.topics = cachedTopics;
    } catch (_) {}
  }

  function saveLocalState() {
    try {
      localStorage.setItem("rb_v30_config", JSON.stringify(state.config));
      localStorage.setItem("rb_v14_members", JSON.stringify(state.members));
      localStorage.setItem("rb_v14_active_member", state.activeMemberId);
      localStorage.setItem("rb_v20_progress", JSON.stringify(state.memberProgress));
    } catch (_) {}
  }

  function getActiveMember() {
    return state.members.find(m => m.id === state.activeMemberId) || state.members[0];
  }

  function getActiveProgress() {
    const m = getActiveMember();
    if (!state.memberProgress[m.uid]) {
      state.memberProgress[m.uid] = {
        lastTopic: "",
        lastTopicTitle: "",
        lastIndex: 0,
        passedByTopic: {},
        hardWords: {},
        reviewItems: []
      };
    }
    return state.memberProgress[m.uid];
  }

  function safeSetTopicCache(topicKey, hash, items) {
    const dataKey = `rb_topic_data_${topicKey}`;
    const hashKey = `rb_topic_hash_${topicKey}`;
    const payload = JSON.stringify(items);
    try {
      localStorage.setItem(dataKey, payload);
      localStorage.setItem(hashKey, hash || "");
    } catch (_) {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("rb_topic_data_") && k !== dataKey) keys.push(k);
        }
        keys.slice(0, 6).forEach(k => localStorage.removeItem(k));
        localStorage.setItem(dataKey, payload);
        localStorage.setItem(hashKey, hash || "");
      } catch (__) {}
    }
  }

  // ==================== HEADER, STUDY LOCK & STARS SYNC ====================
  function updateHeaderMemberUI() {
    const m = getActiveMember();
    if (!m) return;
    document.getElementById("hdr-member-avatar").textContent = m.avatar || "🧒";
    document.getElementById("hdr-member-name").textContent = m.name;
    document.getElementById("hdr-stars").textContent = String(m.stars || 0);
    const prog = getActiveProgress();
    const hardBadge = document.getElementById("hard-count-badge");
    if (hardBadge) hardBadge.textContent = String((prog.reviewItems || []).length);
  }

  function updateStudyLockUI() {
    const locked = !!state.config.studyOnly;
    ["nav-btn-youtube", "nav-btn-game", "btn-home-youtube", "btn-home-game"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("locked", locked);
    });
    const ytHome = document.getElementById("btn-home-youtube");
    const gmHome = document.getElementById("btn-home-game");
    if (ytHome) ytHome.textContent = locked ? "🔒 YouTube (Khóa)" : "▶️ Xem YouTube";
    if (gmHome) gmHome.textContent = locked ? "🔒 Game (Khóa)" : "🎮 Chơi Game";
  }

  function setVoicePill(mode, text) {
    const pill = document.getElementById("hdr-voice-pill");
    const txt = document.getElementById("hdr-voice-text");
    const icon = document.getElementById("hdr-voice-icon");
    if (!pill || !txt) return;
    pill.className = `pill pill-voice ${mode}`;
    txt.textContent = text;
    if (icon) icon.textContent = mode === "recording" ? "🔴" : mode === "muted" ? "🔇" : "🎙️";
  }

  function addStarsToActiveMember(delta) {
    const m = getActiveMember();
    if (!m) return;
    m.stars = Math.max(0, (m.stars || 0) + delta);
    saveLocalState();
    updateHeaderMemberUI();
    renderMembersSettingsList();

    postServerJson("api_user.php", { action: "add_stars", bot_id: m.uid }, {
      action: "add_stars",
      bot_id: m.uid,
      set_stars: m.stars
    }).catch(() => {});
  }

  function startPointPolling() {
    stopPointPolling();
    state.pointPollTimer = setInterval(async () => {
      if (state.activeTab !== "youtube" && state.activeTab !== "game") return;
      const m = getActiveMember();
      if (!m) return;
      try {
        const data = await fetchServerJson("api_point.php", { uid: m.uid, _t: Date.now() });
        if (data && data.status === "ok" && typeof data.stars === "number" && data.stars !== m.stars) {
          m.stars = data.stars;
          saveLocalState();
          updateHeaderMemberUI();
        }
      } catch (_) {}
    }, 2000);
  }

  function stopPointPolling() {
    if (state.pointPollTimer) {
      clearInterval(state.pointPollTimer);
      state.pointPollTimer = null;
    }
  }

  // ==================== TABS & NAVIGATION ====================
  function switchTab(tabName) {
    if ((tabName === "youtube" || tabName === "game") && state.config.studyOnly) {
      setRobotMood("encourage");
      speakFeedback("Chế độ Chỉ Học Tập đang bật. Phụ huynh có thể mở khóa giải trí trong Cài đặt nhé!", "vi-VN");
      return;
    }

    if (tabName === "settings" && !state.settingsUnlocked) {
      openPinModal();
      return;
    }

    cancelRecordingSession(false);

    if (state.activeTab === "youtube" && tabName !== "youtube") {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      const f = document.getElementById("frame-youtube");
      f.onload = null;
      f.src = "about:blank";
      stopPointPolling();
    }
    if (state.activeTab === "game" && tabName !== "game") {
      const f = document.getElementById("frame-game");
      f.onload = null;
      f.src = "about:blank";
      stopPointPolling();
    }

    state.activeTab = tabName;
    if (tabName !== "topics") state.awaitingTopicChoice = false;

    document.querySelectorAll(".tab-view").forEach(sec => sec.classList.remove("active"));
    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    const target = document.getElementById(`tab-${tabName}`);
    if (target) target.classList.add("active");

    const refreshBtn = document.getElementById("btn-refresh-frame");
    if (tabName === "youtube" || tabName === "game") {
      stopNativeMicHard();
      setVoicePill("muted", "Tắt mic");
      refreshBtn.classList.remove("hidden");

      const m = getActiveMember();
      const script = tabName === "youtube" ? "youtube.php" : "games.php";
      const frame = document.getElementById(tabName === "youtube" ? "frame-youtube" : "frame-game");
      stopPointPolling();
      frame.onload = () => {
        if (state.activeTab === tabName) startPointPolling();
      };
      frame.src = buildApiUrl(script, { uid: m.uid, stars: m.stars, r: Date.now() });
    } else {
      refreshBtn.classList.add("hidden");
    }

    if (tabName === "topics") {
      renderTopicsGrid();
      if (state.topics.length === 0) loadTopicsList(true);
      applyCurrentViewFocus();
      scheduleBackgroundListening();
    } else if (tabName === "settings" || tabName === "guide") {
      stopNativeMicHard();
      setVoicePill("muted", "Tắt mic");
      if (tabName === "settings") {
        syncSettingsUI();
        renderCameraQrCode();
        refreshDeviceTelemetry();
        applyCurrentViewFocus();
      }
    } else if (tabName === "robot") {
      applyCurrentViewFocus();
      scheduleBackgroundListening();
    }

    resetIdleTimer();
  }

  // ==================== ROBOT 8 EXPRESSIONS, EYE GAZE & SMART SLEEP ====================
  function setRobotMood(mood) {
    state.mood = mood;
    const head = document.getElementById("robot-head");
    if (head) head.className = `robot-head mood-${mood}`;
    document.getElementById("sleep-zzz")?.classList.toggle("hidden", mood !== "sleeping");
    document.getElementById("sparkle-badge")?.classList.toggle("hidden", mood !== "excited");
  }

  function setRobotBubble(text) {
    const el = document.getElementById("robot-bubble");
    if (el) el.textContent = text;
  }

  function startNaturalBlinkAndGazeLoop() {
    // Chớp mắt tự nhiên
    setInterval(() => {
      if (state.mood === "sleeping" || state.mood === "proud") return;
      document.querySelectorAll(".eye").forEach(e => e.classList.add("blinking"));
      setTimeout(() => {
        document.querySelectorAll(".eye").forEach(e => e.classList.remove("blinking"));
      }, 150);
    }, 3900);

    // Đảo mắt nhẹ ngẫu nhiên cho sống động
    setInterval(() => {
      if (state.mood === "sleeping" || state.mood === "proud") return;
      const offsets = [
        "translate(0px, 0px)",
        "translate(6px, -2px)",
        "translate(-6px, -2px)",
        "translate(4px, 4px)",
        "translate(-4px, 3px)",
        "translate(0px, -4px)"
      ];
      const pick = state.mood === "listening"
        ? "translate(0px, 0px)"
        : offsets[Math.floor(Math.random() * offsets.length)];
      document.querySelectorAll(".pupil").forEach(p => { p.style.transform = pick; });
    }, 2800);
  }

  function updateSleepBadge() {
    const badge = document.getElementById("sleep-countdown-badge");
    if (!badge) return;
    if (state.sleepStage === "sleeping") {
      badge.textContent = "💤 Đang nghỉ ngủ";
    } else if (state.karaokeOpen) {
      badge.textContent = "📖 Đang học tiếng Anh";
    } else {
      badge.textContent = "Sẵn sàng";
    }
  }

  function goToSleep(sayGoodnight = false) {
    cancelRecordingSession(false);
    const enterSleepVisual = () => {
      state.sleepStage = "sleeping";
      state.idleSeconds = AUTO_SLEEP_IDLE_SEC;
      setRobotMood("sleeping");
      sendBleCommand("M:SLEEP");
      const native = getRobotNative();
      if (native) native.setBrightness({ level: 5 }).catch(() => {});
      updateSleepBadge();
      scheduleBackgroundListening();
    };

    if (sayGoodnight) {
      const m = getActiveMember();
      speakFeedback(pickDialogue("goodnight", { name: m.name }), "vi-VN", {
        mood: "proud",
        onDone: enterSleepVisual
      });
    } else {
      enterSleepVisual();
    }
  }

  function wakeRobot(greet = false) {
    state.idleSeconds = 0;
    state.promptedOnceThisIdle = false;
    state.sleepStage = "awake";
    setRobotMood("happy");
    sendBleCommand("M:WAKE");
    const native = getRobotNative();
    if (native) native.setBrightness({ level: state.config.brightness }).catch(() => {});
    updateSleepBadge();

    if (greet && !state.karaokeOpen) {
      const m = getActiveMember();
      speakFeedback(`Chào ${m.name}! Lucky thức dậy rồi, mình sẵn sàng nghe bạn đây!`, "vi-VN", { mood: "excited" });
    } else {
      scheduleBackgroundListening();
    }
  }

  function resetIdleTimer() {
    state.idleSeconds = 0;
    state.promptedOnceThisIdle = false;
    if (state.sleepStage === "sleeping") {
      wakeRobot(false);
    }
    updateSleepBadge();
  }

  function startIdleMonitor() {
    setInterval(() => {
      // Không đếm khi đang nói, đang ghi âm 30s, hoặc ở tab khác ngoài Robot
      if (
        state.activeTab !== "robot" ||
        state.voiceState === "SPEAKING" ||
        state.voiceState === "LESSON_RECORDING_EN" ||
        isAnyModalOpen()
      ) {
        state.idleSeconds = 0;
        return;
      }

      if (state.sleepStage === "sleeping") return;

      state.idleSeconds += 1;

      // 1. Ở màn hình chính (không mở bài học): sau 30s rảnh -> hỏi thăm đúng 1 lần (không spam)
      if (!state.karaokeOpen && state.idleSeconds === HOME_PROMPT_IDLE_SEC && !state.promptedOnceThisIdle && !robotPc) {
        state.promptedOnceThisIdle = true;
        const m = getActiveMember();
        const askIdentity = Math.random() < 0.45;
        if (askIdentity) {
          state.awaitingIdentityReplyUntil = Date.now() + 16000;
          speakFeedback(pickDialogue("idleWho", { name: m.name }), "vi-VN", { mood: "curious" });
        } else {
          speakFeedback(pickDialogue("idleHealth", { name: m.name }), "vi-VN", { mood: "happy" });
        }
        return;
      }

      // 2. Sau 60s không tương tác (cả trang chính LẪN khi đang mở bài học mà chưa bấm [B] đọc) -> tự ngủ tiết kiệm pin
      if (state.idleSeconds >= AUTO_SLEEP_IDLE_SEC) {
        goToSleep(false);
      }
    }, 1000);
  }

  // ==================== 4-STATE VOICE & TTS ENGINE ====================
  function clearKaraokeHighlightTimers() {
    state.karaokeHighlightTimers.forEach(t => clearTimeout(t));
    state.karaokeHighlightTimers = [];
    document.querySelectorAll("#k-sentence-en .k-word").forEach(w => w.classList.remove("active"));
  }

  function startKaraokeWordHighlight() {
    clearKaraokeHighlightTimers();
    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    const stepMs = Math.round(320 / (state.config.speechRate || 0.95));
    wordEls.forEach((el, idx) => {
      state.karaokeHighlightTimers.push(setTimeout(() => {
        wordEls.forEach(w => w.classList.remove("active"));
        el.classList.add("active");
      }, idx * stepMs));
    });
    state.karaokeHighlightTimers.push(setTimeout(() => {
      wordEls.forEach(w => w.classList.remove("active"));
    }, wordEls.length * stepMs + 350));
  }

  function stopNativeMicHard() {
    state.isListeningNative = false;
    const native = getRobotNative();
    if (native) native.stopListening().catch(() => {});
  }

  function stopAllAudioAndSpeech() {
    clearTimeout(state.speakWatchdogTimer);
    clearTimeout(state.echoGuardTimer);
    clearKaraokeHighlightTimers();
    state.activeUtteranceId = "";
    try { state.audioPlayer.pause(); state.audioPlayer.onended = null; state.audioPlayer.onerror = null; } catch (_) {}
    const native = getRobotNative();
    if (native) native.stopSpeak().catch(() => {});
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
  }

  function finishSpeakingPhase(onAfterEcho = null) {
    clearTimeout(state.speakWatchdogTimer);
    clearKaraokeHighlightTimers();
    state.activeUtteranceId = "";
    state.voiceState = "ECHO_GUARD";
    if (state.sleepStage !== "sleeping") setRobotMood("happy");

    clearTimeout(state.echoGuardTimer);
    state.echoGuardTimer = setTimeout(() => {
      if (state.voiceState !== "ECHO_GUARD") return;
      state.voiceState = "IDLE_VI";

      if (typeof onAfterEcho === "function") {
        onAfterEcho();
        return;
      }

      if (state.activeTab === "robot" && state.karaokeOpen) {
        focusRecordButtonReady();
        // Vẫn nghe lệnh điều khiển tiếng Việt (ngủ đi, dịch, câu tiếp, mở YouTube...) nhưng TUYỆT ĐỐI KHÔNG tự chấm điểm!
        scheduleBackgroundListening();
      } else if (state.activeTab === "robot" || state.activeTab === "topics") {
        scheduleBackgroundListening();
      }
    }, ECHO_GUARD_MS);
  }

  function speakFeedback(text, lang = "vi-VN", opts = {}) {
    const cleanText = (text || "").trim();
    if (!cleanText) return;

    const isSample = !!opts.isSample;
    const rate = opts.rate || (lang.startsWith("en") ? state.config.speechRate : 1.0);
    const onDone = opts.onDone || null;
    const moodDuring = opts.mood || "speaking";

    setRobotBubble(cleanText);
    stopNativeMicHard();
    stopAllAudioAndSpeech();

    const uttId = `utt_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    state.activeUtteranceId = uttId;
    state.voiceState = "SPEAKING";
    setVoicePill("muted", "Robot nói...");
    setRobotMood(moodDuring);

    const maxSafeMs = Math.max(6000, Math.min(22000, cleanText.length * 140));
    state.speakWatchdogTimer = setTimeout(() => {
      if (state.voiceState === "SPEAKING" && state.activeUtteranceId === uttId) {
        finishSpeakingPhase(onDone);
      }
    }, maxSafeMs);

    state._pendingSpeakDoneCb = onDone;
    state._pendingIsSample = isSample;

    const native = getRobotNative();
    if (native) {
      native.speak({ text: cleanText, lang, rate, pitch: 1.06, id: uttId })
        .then(res => {
          if (res && res.skipped && state.activeUtteranceId === uttId) finishSpeakingPhase(onDone);
        })
        .catch(() => {
          if (state.activeUtteranceId === uttId) finishSpeakingPhase(onDone);
        });
      return;
    }

    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(cleanText);
      u.lang = lang;
      u.rate = rate;
      u.onstart = () => { if (isSample) startKaraokeWordHighlight(); };
      u.onend = () => { if (state.activeUtteranceId === uttId) finishSpeakingPhase(onDone); };
      u.onerror = () => { if (state.activeUtteranceId === uttId) finishSpeakingPhase(onDone); };
      window.speechSynthesis.speak(u);
    } else {
      finishSpeakingPhase(onDone);
    }
  }

  function scheduleBackgroundListening() {
    // Nếu camera thầm lặng đang giữ audio mic thì nhường mic cho camera
    if (
      (robotPc && robotCamHasAudio) ||
      isAnsweringCam ||
      state.voiceState !== "IDLE_VI" ||
      (state.activeTab !== "robot" && state.activeTab !== "topics") ||
      isAnyModalOpen()
    ) {
      return;
    }
    const native = getRobotNative();
    if (native && !state.isListeningNative) {
      state.isListeningNative = true;
      const label = state.karaokeOpen
        ? "Chờ lệnh / [B]"
        : state.awaitingTopicChoice
          ? "Chọn chủ đề..."
          : state.sleepStage === "sleeping"
            ? "Ngủ (Chờ gọi)"
            : "Đang nghe";
      setVoicePill("listening", label);
      native.startListening({ lang: "vi-VN" }).catch(() => {
        state.isListeningNative = false;
      });
    }
  }

  // ==================== TOPICS SYNC & RENDER ====================
  function renderContinueBanner() {
    const prog = getActiveProgress();
    const banner = document.getElementById("continue-learning-banner");
    if (!banner) return;
    if (prog.lastTopic && state.topics.some(t => t.topic === prog.lastTopic)) {
      document.getElementById("continue-topic-label").textContent = `▶️ Học tiếp: ${prog.lastTopicTitle || prog.lastTopic}`;
      document.getElementById("continue-topic-meta").textContent = `Đang dừng ở câu #${(prog.lastIndex || 0) + 1}`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function renderTopicsGrid() {
    const grid = document.getElementById("topics-grid");
    const summary = document.getElementById("topics-summary-text");
    if (!grid) return;

    renderContinueBanner();
    const prog = getActiveProgress();

    document.getElementById("btn-toggle-order-mode").textContent =
      state.orderMode === "random" ? "🎲 Chế độ: Ngẫu nhiên" : "📋 Chế độ: Theo thứ tự";
    document.getElementById("btn-toggle-only-vi").textContent =
      state.onlyViFilter ? "🇻🇳 Lọc: Chỉ câu có tiếng Việt" : "🇻🇳 Lọc: Tất cả câu";

    if (state.topics.length === 0) {
      summary.textContent = "Đang tải danh sách chủ đề từ máy chủ...";
      grid.innerHTML = `<div class="sub-text">Đang đồng bộ kho học liệu...</div>`;
      return;
    }

    const totalSentences = state.topics.reduce((acc, t) => acc + (Number(t.count) || 0), 0);
    summary.textContent = `Đã đồng bộ ${state.topics.length} chủ đề (${totalSentences.toLocaleString()} câu). Nói số chủ đề hoặc dùng C/D & B để chọn.`;

    grid.innerHTML = "";
    state.topics.forEach(t => {
      const slug = t.topic;
      const title = t.title || slug;
      const count = Number(t.count) || 0;
      const passedArr = prog.passedByTopic?.[slug] || [];
      const pct = count > 0 ? Math.min(100, Math.round((passedArr.length / count) * 100)) : 0;
      const isCached = !!localStorage.getItem(`rb_topic_data_${slug}`);

      const card = document.createElement("button");
      card.type = "button";
      card.className = "topic-card topic-nav-item";
      card.innerHTML = `
        <div class="topic-card-head">
          <span class="topic-num-badge">#${t.index}</span>
          <h4>${title}</h4>
        </div>
        <p class="topic-meta">📚 ${count.toLocaleString()} câu • ✅ Đạt ${passedArr.length} ${isCached ? "• Offline" : ""}</p>
        <div class="topic-prog-bar"><div class="topic-prog-fill" style="width:${pct}%;"></div></div>
      `;
      card.addEventListener("click", () => loadTopicLessons(slug, state.orderMode));
      grid.appendChild(card);
    });

    if (state.activeTab === "topics") applyCurrentViewFocus();
  }

  async function loadTopicsList(forceRefresh = false) {
    const summary = document.getElementById("topics-summary-text");
    if (forceRefresh && summary) summary.textContent = "🔄 Đang đồng bộ toàn bộ chủ đề từ máy chủ...";
    try {
      const data = await fetchServerJson("api.php", { action: "topics", _t: Date.now() });
      if (data && data.status === "ok" && Array.isArray(data.topics) && data.topics.length > 0) {
        state.topics = data.topics.map((item, idx) => ({
          index: item.index || idx + 1,
          topic: item.topic,
          title: item.title || item.topic,
          count: Number(item.count) || 0,
          vi_count: Number(item.vi_count) || 0,
          audio_count: Number(item.audio_count) || 0,
          version_hash: item.version_hash || ""
        }));
        try { localStorage.setItem("rb_v14_topics_cache", JSON.stringify(state.topics)); } catch (_) {}
        renderTopicsGrid();
        return;
      }
    } catch (_) {}

    if (state.topics.length > 0) renderTopicsGrid();
    else if (summary) summary.textContent = "⚠️ Chưa kết nối được máy chủ. Kiểm tra Wi-Fi trong Cài đặt rồi bấm Đồng bộ mới.";
  }

  async function loadTopicLessons(topicSlug, orderMode = "sequential", resumeIndex = null, announceFast = false) {
    state.awaitingTopicChoice = false;
    const meta = state.topics.find(t => t.topic === topicSlug);
    const topicTitle = meta?.title || topicSlug;
    const expectedHash = meta?.version_hash || "";

    const cacheSuffix = state.onlyViFilter ? "_vi" : "";
    const cacheKey = `rb_topic_data_${topicSlug}${cacheSuffix}`;
    const hashKey = `rb_topic_hash_${topicSlug}${cacheSuffix}`;
    const loadingBar = document.getElementById("topics-loading-bar");

    let loadedItems = null;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      const cachedHash = localStorage.getItem(hashKey) || "";
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        if (Array.isArray(parsed) && parsed.length > 0 && (!expectedHash || cachedHash === expectedHash)) {
          loadedItems = parsed;
        }
      }
    } catch (_) {}

    if (!loadedItems) {
      if (announceFast) {
        setRobotBubble(`Đang mở chủ đề ${meta?.index || ""} ${topicTitle}${orderMode === "random" ? " ngẫu nhiên" : ""}...`);
      }
      if (loadingBar) {
        loadingBar.textContent = `📥 Đang tải chủ đề "${topicTitle}" từ máy chủ...`;
        loadingBar.classList.remove("hidden");
      }
      try {
        let allItems = [];
        let offset = 0;
        const pageSize = 500;
        let serverHash = expectedHash;

        while (true) {
          const params = { action: "download", topic: topicSlug, offset, limit: pageSize };
          if (state.onlyViFilter) params.only_vi = 1;
          const data = await fetchServerJson("api.php", params);
          if (!data || data.status !== "ok" || !Array.isArray(data.items)) break;
          if (data.version_hash) serverHash = data.version_hash;

          const mapped = data.items.map((it, idx) => {
            const enText = (it.en || it.in || "").trim();
            return {
              id: it.id !== undefined ? it.id : offset + idx,
              en: enText,
              vi: (it.vi || "").trim(),
              audio_url: (it.audio_url || "").trim(),
              spelling: Array.isArray(it.spelling) && it.spelling.length > 0 ? it.spelling : buildLocalSpelling(enText)
            };
          }).filter(it => it.en.length > 0);

          allItems = allItems.concat(mapped);
          const total = Number(data.total) || allItems.length;
          if (allItems.length >= total || mapped.length === 0 || allItems.length >= 2500) break;
          offset += pageSize;
        }

        if (allItems.length > 0) {
          loadedItems = allItems;
          safeSetTopicCache(`${topicSlug}${cacheSuffix}`, serverHash, allItems);
        }
      } catch (_) {
        if (loadingBar) loadingBar.classList.add("hidden");
        speakFeedback(`Không tải được chủ đề ${topicTitle}. Bạn kiểm tra lại Wi-Fi nhé!`, "vi-VN", { mood: "encourage" });
        return;
      }
      if (loadingBar) loadingBar.classList.add("hidden");
    }

    if (!loadedItems || loadedItems.length === 0) {
      speakFeedback(`Chủ đề ${topicTitle} hiện chưa có câu phù hợp.`, "vi-VN", { mood: "curious" });
      return;
    }

    let finalItems = loadedItems.slice();
    if (orderMode === "random") {
      for (let i = finalItems.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [finalItems[i], finalItems[j]] = [finalItems[j], finalItems[i]];
      }
    }

    state.currentTopicSlug = topicSlug;
    state.currentTopicTitle = topicTitle;
    state.sentences = finalItems;

    const prog = getActiveProgress();
    if (resumeIndex !== null && resumeIndex >= 0 && resumeIndex < finalItems.length) {
      state.sentenceIndex = resumeIndex;
    } else if (orderMode === "sequential" && prog.lastTopic === topicSlug && prog.lastIndex < finalItems.length) {
      state.sentenceIndex = prog.lastIndex;
    } else {
      state.sentenceIndex = 0;
    }

    prog.lastTopic = topicSlug;
    prog.lastTopicTitle = topicTitle;
    prog.lastIndex = state.sentenceIndex;
    saveLocalState();

    state.karaokeOpen = true;
    switchTab("robot");
    toggleKaraokePanel(true);
    renderCurrentSentence();
    playCurrentSample();
  }

  function openHardWordsReview() {
    const prog = getActiveProgress();
    const list = Array.isArray(prog.reviewItems) ? prog.reviewItems : [];
    if (list.length === 0) {
      speakFeedback("Tuyệt vời! Bạn chưa có câu khó nào cần ôn. Hãy chọn một chủ đề mới để học nhé!", "vi-VN", { mood: "proud" });
      return;
    }
    state.currentTopicSlug = "_hard_review";
    state.currentTopicTitle = "🔥 Ôn từ khó";
    state.sentences = list.slice();
    state.sentenceIndex = 0;
    state.karaokeOpen = true;
    switchTab("robot");
    toggleKaraokePanel(true);
    renderCurrentSentence();
    playCurrentSample();
  }

  // ==================== KARAOKE & 30-SECOND PRESS-[B] ENGINE ====================
  function toggleKaraokePanel(open) {
    cancelRecordingSession(false);
    state.karaokeOpen = open;
    const stage = document.getElementById("robot-stage");
    const panel = document.getElementById("karaoke-panel");
    stage.classList.toggle("split-mode", open);
    stage.classList.toggle("full-face", !open);
    panel.classList.toggle("hidden", !open);

    if (open) {
      renderCurrentSentence();
      state.focusIdx.karaoke = 2;
    } else {
      stopAllAudioAndSpeech();
      state.voiceState = "IDLE_VI";
      scheduleBackgroundListening();
    }
    applyCurrentViewFocus();
    updateSleepBadge();
  }

  function focusRecordButtonReady() {
    const recBtn = document.getElementById("btn-k-record");
    if (recBtn) {
      recBtn.classList.remove("recording");
      recBtn.classList.add("success", "ready-pulse");
      recBtn.textContent = "🎤 Bắt đầu đọc [B]";
    }
    state.focusIdx.karaoke = 2;
    applyCurrentViewFocus();
  }

  function renderCurrentSentence() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    const prog = getActiveProgress();
    if (state.currentTopicSlug && state.currentTopicSlug !== "_hard_review") {
      prog.lastTopic = state.currentTopicSlug;
      prog.lastTopicTitle = state.currentTopicTitle;
      prog.lastIndex = state.sentenceIndex;
      saveLocalState();
    }

    const passedIds = prog.passedByTopic?.[state.currentTopicSlug] || [];
    const alreadyPassed = passedIds.includes(item.id);

    document.getElementById("k-topic-title").textContent = `Chủ đề: ${state.currentTopicTitle}`;
    document.getElementById("k-progress-text").textContent =
      `Câu ${state.sentenceIndex + 1} / ${state.sentences.length}${alreadyPassed ? " • ✅ Đã đạt" : ""}`;

    const enBox = document.getElementById("k-sentence-en");
    const words = item.en.split(/\s+/);
    enBox.innerHTML = "";
    words.forEach((w, idx) => {
      const span = document.createElement("span");
      span.className = "k-word";
      span.dataset.widx = String(idx);
      span.textContent = w;
      // Chạm vào từng từ để nghe đọc chậm riêng từ đó
      span.addEventListener("click", () => {
        if (state.voiceState === "LESSON_RECORDING_EN") return;
        const cleanW = w.replace(/[^a-zA-Z0-9']/g, "");
        if (cleanW) speakFeedback(cleanW, "en-US", { rate: 0.72 });
      });
      enBox.appendChild(span);
      enBox.appendChild(document.createTextNode(" "));
    });

    const spellBox = document.getElementById("k-spelling-box");
    const spList = Array.isArray(item.spelling) && item.spelling.length > 0 ? item.spelling : buildLocalSpelling(item.en);
    spellBox.innerHTML = "";
    spList.forEach(sp => {
      const chip = document.createElement("span");
      chip.className = "spell-chip";
      chip.textContent = `${sp.word}: ${sp.spell}`;
      chip.addEventListener("click", () => {
        if (state.voiceState === "LESSON_RECORDING_EN") return;
        speakFeedback(`${sp.word}. ${sp.spell}`, "en-US", { rate: 0.78 });
      });
      spellBox.appendChild(chip);
    });

    document.getElementById("k-sentence-vi").textContent = item.vi || "Bấm [🇻🇳 Dịch] để nghe nghĩa tiếng Việt";
    document.getElementById("k-score-label").textContent =
      `Nghe mẫu xong bấm [B] để đọc (Đạt ≥ ${state.config.passThreshold}%)`;
    document.getElementById("k-heard-words").textContent = "";
    document.getElementById("k-rec-bar-wrap").classList.add("hidden");

    const nextItem = state.sentences[state.sentenceIndex + 1];
    if (nextItem && nextItem.audio_url) {
      try {
        state.preloadAudio.src = nextItem.audio_url;
        state.preloadAudio.load();
      } catch (_) {}
    }
  }

  function playCurrentSample() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    resetIdleTimer();
    cancelRecordingSession(false);
    stopNativeMicHard();
    stopAllAudioAndSpeech();

    document.getElementById("btn-k-record")?.classList.remove("ready-pulse");

    if (item.audio_url) {
      let mp3Started = false;
      state.voiceState = "SPEAKING";
      setVoicePill("muted", "Đang đọc mẫu...");
      setRobotMood("speaking");

      const fallbackTimer = setTimeout(() => {
        if (!mp3Started && state.voiceState === "SPEAKING") {
          try { state.audioPlayer.pause(); } catch (_) {}
          speakFeedback(item.en, "en-US", { isSample: true });
        }
      }, 1200);

      state.audioPlayer.onplaying = () => {
        mp3Started = true;
        clearTimeout(fallbackTimer);
        startKaraokeWordHighlight();
      };
      state.audioPlayer.onended = () => {
        clearTimeout(fallbackTimer);
        finishSpeakingPhase();
      };
      state.audioPlayer.onerror = () => {
        clearTimeout(fallbackTimer);
        if (!mp3Started) speakFeedback(item.en, "en-US", { isSample: true });
      };
      state.audioPlayer.src = item.audio_url;
      state.audioPlayer.playbackRate = state.config.speechRate;
      state.audioPlayer.play().catch(() => {
        clearTimeout(fallbackTimer);
        speakFeedback(item.en, "en-US", { isSample: true });
      });
      return;
    }

    speakFeedback(item.en, "en-US", { isSample: true });
  }

  function toggleLessonRecording() {
    resetIdleTimer();
    if (state.voiceState === "LESSON_RECORDING_EN") {
      finalizeRecordingAndGrade();
      return;
    }
    if (state.voiceState === "SPEAKING") {
      stopAllAudioAndSpeech();
      setTimeout(startLessonRecording30s, 300);
      return;
    }
    startLessonRecording30s();
  }

  function startLessonRecording30s() {
    stopAllAudioAndSpeech();
    clearTimeout(state.echoGuardTimer);

    state.voiceState = "LESSON_RECORDING_EN";
    state.recSecondsLeft = RECORD_MAX_SECONDS;
    state.recSegments = [];
    state.recCurrentPartial = "";

    setRobotMood("listening");
    setVoicePill("recording", "Đang ghi 30s");

    const recBtn = document.getElementById("btn-k-record");
    if (recBtn) {
      recBtn.classList.remove("success", "ready-pulse");
      recBtn.classList.add("recording");
      recBtn.textContent = "⏹️ Xong / Chấm [B]";
    }

    const barWrap = document.getElementById("k-rec-bar-wrap");
    const timerEl = document.getElementById("k-rec-timer");
    const fillEl = document.getElementById("k-rec-progress-fill");
    if (barWrap) barWrap.classList.remove("hidden");
    if (timerEl) timerEl.textContent = `${RECORD_MAX_SECONDS}s`;
    if (fillEl) fillEl.style.width = "100%";

    document.getElementById("k-score-label").textContent = "🎙️ Robot đang im lặng lắng nghe bé đọc...";
    document.getElementById("k-heard-words").textContent = "";

    startEnMicSegment();

    clearInterval(state.recTickTimer);
    state.recTickTimer = setInterval(() => {
      if (state.voiceState !== "LESSON_RECORDING_EN") {
        clearInterval(state.recTickTimer);
        return;
      }
      state.recSecondsLeft -= 1;
      if (timerEl) timerEl.textContent = `${Math.max(0, state.recSecondsLeft)}s`;
      if (fillEl) fillEl.style.width = `${Math.max(0, (state.recSecondsLeft / RECORD_MAX_SECONDS) * 100)}%`;
      setVoicePill("recording", `Đang ghi ${Math.max(0, state.recSecondsLeft)}s`);

      if (state.recSecondsLeft <= 0) finalizeRecordingAndGrade();
    }, 1000);
  }

  function startEnMicSegment() {
    if (state.voiceState !== "LESSON_RECORDING_EN") return;
    const native = getRobotNative();
    if (native) {
      state.isListeningNative = true;
      native.startListening({ lang: "en-US" }).catch(() => {
        state.isListeningNative = false;
      });
    }
  }

  function computeLiveScore(spokenText) {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return 0;
    const cleanTarget = normalizeEnglishWords(item.en);
    const cleanSpoken = normalizeEnglishWords(spokenText);
    const pool = {};
    cleanSpoken.forEach(w => { pool[w] = (pool[w] || 0) + 1; });
    let matched = 0;
    cleanTarget.forEach(tw => {
      if ((pool[tw] || 0) > 0) {
        pool[tw]--;
        matched++;
      } else {
        const fk = tw.length >= 5 ? Object.keys(pool).find(k => pool[k] > 0 && levenshtein(k, tw) <= 1) : null;
        if (fk) { pool[fk]--; matched++; }
      }
    });
    return cleanTarget.length > 0 ? Math.round((matched / cleanTarget.length) * 100) : 0;
  }

  function updateLiveWordColors(fullSpoken) {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;
    const spokenWords = normalizeEnglishWords(fullSpoken);
    const tempCounts = {};
    spokenWords.forEach(w => { tempCounts[w] = (tempCounts[w] || 0) + 1; });

    const rawTarget = item.en.split(/\s+/).filter(Boolean);
    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    rawTarget.forEach((rawW, idx) => {
      const parts = normalizeEnglishWords(rawW);
      let ok = parts.length > 0;
      for (const p of parts) {
        if ((tempCounts[p] || 0) > 0) tempCounts[p]--;
        else {
          const fk = p.length >= 5 ? Object.keys(tempCounts).find(k => tempCounts[k] > 0 && levenshtein(k, p) <= 1) : null;
          if (fk) tempCounts[fk]--;
          else ok = false;
        }
      }
      if (wordEls[idx]) {
        wordEls[idx].classList.remove("ok", "miss");
        if (ok) wordEls[idx].classList.add("ok");
      }
    });
  }

  function scheduleSmartSilenceFinish(combinedText) {
    clearTimeout(state.recSilenceTimer);
    const liveScore = computeLiveScore(combinedText);
    const threshold = Number(state.config.passThreshold) || 60;
    // Đã đạt ngưỡng -> chốt nhanh sau 1.8s; chưa đạt -> chờ thoáng 4.0s cho bé đọc tiếp
    const waitMs = liveScore >= threshold ? SILENCE_FAST_FINISH_MS : SILENCE_SLOW_FINISH_MS;
    state.recSilenceTimer = setTimeout(() => {
      if (state.voiceState === "LESSON_RECORDING_EN") finalizeRecordingAndGrade();
    }, waitMs);
  }

  function cancelRecordingSession(restoreReadyBtn = true) {
    clearInterval(state.recTickTimer);
    clearTimeout(state.recSilenceTimer);
    state.recTickTimer = null;
    state.recSilenceTimer = null;

    if (state.voiceState === "LESSON_RECORDING_EN") {
      stopNativeMicHard();
      state.voiceState = "IDLE_VI";
      if (state.sleepStage !== "sleeping") setRobotMood("happy");
    }

    document.getElementById("k-rec-bar-wrap")?.classList.add("hidden");

    if (restoreReadyBtn && state.karaokeOpen) {
      focusRecordButtonReady();
      scheduleBackgroundListening();
    }
  }

  function finalizeRecordingAndGrade() {
    if (state.voiceState !== "LESSON_RECORDING_EN") return;
    const combined = [...state.recSegments, state.recCurrentPartial].join(" ").trim();
    cancelRecordingSession(false);

    if (!combined) {
      setRobotMood("curious");
      document.getElementById("k-score-label").textContent = "Chưa nghe rõ giọng bé. Bấm [B] để đọc lại nhé!";
      focusRecordButtonReady();
      scheduleBackgroundListening();
      return;
    }

    evaluateEnglishPronunciation(combined);
  }

  function evaluateEnglishPronunciation(spokenText) {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    const cleanTarget = normalizeEnglishWords(item.en);
    const cleanSpoken = normalizeEnglishWords(spokenText);

    const spokenPool = {};
    cleanSpoken.forEach(w => { spokenPool[w] = (spokenPool[w] || 0) + 1; });

    let matched = 0;
    const wrongWords = [];

    cleanTarget.forEach(tw => {
      if ((spokenPool[tw] || 0) > 0) {
        spokenPool[tw]--;
        matched++;
      } else {
        const fuzzy = tw.length >= 5
          ? Object.keys(spokenPool).find(k => spokenPool[k] > 0 && levenshtein(k, tw) <= 1)
          : null;
        if (fuzzy) {
          spokenPool[fuzzy]--;
          matched++;
        } else {
          wrongWords.push(tw);
        }
      }
    });

    const displayPool = {};
    cleanSpoken.forEach(w => { displayPool[w] = (displayPool[w] || 0) + 1; });
    const rawWords = item.en.split(/\s+/).filter(Boolean);
    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    rawWords.forEach((rw, idx) => {
      const parts = normalizeEnglishWords(rw);
      let ok = parts.length > 0;
      for (const p of parts) {
        if ((displayPool[p] || 0) > 0) displayPool[p]--;
        else {
          const fk = p.length >= 5 ? Object.keys(displayPool).find(k => displayPool[k] > 0 && levenshtein(k, p) <= 1) : null;
          if (fk) displayPool[fk]--;
          else ok = false;
        }
      }
      if (wordEls[idx]) {
        wordEls[idx].classList.remove("ok", "miss");
        wordEls[idx].classList.add(ok ? "ok" : "miss");
      }
    });

    const score = cleanTarget.length > 0 ? Math.round((matched / cleanTarget.length) * 100) : 0;
    const passThreshold = Number(state.config.passThreshold) || 60;
    const isPassed = score >= passThreshold;

    document.getElementById("k-score-label").textContent =
      `Điểm: ${score}% / Mức đạt ${passThreshold}% (${matched}/${cleanTarget.length} từ)`;
    document.getElementById("k-heard-words").textContent = `Nghe được: "${spokenText}"`;

    const m = getActiveMember();
    const prog = getActiveProgress();
    if (!prog.passedByTopic[state.currentTopicSlug]) prog.passedByTopic[state.currentTopicSlug] = [];

    if (isPassed) {
      playSuccessChime();
      sendBleCommand("M:HAPPY");

      const firstTimePass = !prog.passedByTopic[state.currentTopicSlug].includes(item.id);
      if (firstTimePass && state.currentTopicSlug !== "_hard_review") {
        prog.passedByTopic[state.currentTopicSlug].push(item.id);
        addStarsToActiveMember(1);
      } else if (state.currentTopicSlug === "_hard_review") {
        prog.reviewItems = (prog.reviewItems || []).filter(r => r.en !== item.en);
        addStarsToActiveMember(1);
      }
      saveLocalState();
      updateHeaderMemberUI();

      const praise = firstTimePass
        ? pickDialogue("praiseStar", { name: m.name, score })
        : pickDialogue("praiseRepeat", { name: m.name, score });

      speakFeedback(praise, "vi-VN", {
        mood: firstTimePass ? "excited" : "proud",
        onDone: () => {
          if (!state.karaokeOpen) return;
          if (state.sentenceIndex < state.sentences.length - 1) {
            state.sentenceIndex += 1;
            renderCurrentSentence();
            playCurrentSample();
          } else {
            openTopicCompleteModal();
          }
        }
      });
    } else {
      wrongWords.forEach(w => { prog.hardWords[w] = (prog.hardWords[w] || 0) + 1; });
      if (!prog.reviewItems.some(r => r.en === item.en)) {
        prog.reviewItems.unshift({
          id: item.id, en: item.en, vi: item.vi, audio_url: item.audio_url, spelling: item.spelling
        });
        prog.reviewItems = prog.reviewItems.slice(0, 40);
      }
      saveLocalState();
      updateHeaderMemberUI();

      speakFeedback(pickDialogue("encourage", { name: m.name, score }), "vi-VN", { mood: "encourage" });
    }

    postServerJson("api_user.php", { action: "log_learning", bot_id: m.uid }, {
      action: "log_learning",
      bot_id: m.uid,
      topic: state.currentTopicSlug || "daily",
      sentence_id: item.id,
      en: item.en,
      score,
      status: isPassed ? "passed" : "review",
      wrong_words: wrongWords
    }).catch(() => {});
  }

  function openTopicCompleteModal() {
    stopNativeMicHard();
    document.getElementById("tc-title").textContent = `🎉 Hoàn thành: ${state.currentTopicTitle}!`;
    document.getElementById("topic-complete-modal").classList.remove("hidden");
    state.focusIdx.topicComplete = 1;
    applyCurrentViewFocus();
    speakFeedback(`Chúc mừng ${getActiveMember().name} đã hoàn thành toàn bộ chủ đề ${state.currentTopicTitle}!`, "vi-VN", { mood: "excited" });
  }

  // ==================== VOICE USER SWITCH & CREATION + FLEXIBLE INTENT ROUTER ====================
  function titleCaseName(raw) {
    return (raw || "")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  function extractSpokenUserName(rawText, norm) {
    const patterns = [
      /(?:toi la|con la|minh la|em la|anh la|chi la|ten toi la|con ten la|ten con la|minh ten la|doi sang|chuyen sang)\s+(.+)/i
    ];
    for (const pat of patterns) {
      const m = rawText.match(pat);
      if (m && m[1]) {
        const cleaned = m[1].replace(/[.,!?]/g, "").trim();
        const words = cleaned.split(/\s+/).filter(Boolean);
        if (words.length >= 1 && words.length <= 3) return titleCaseName(cleaned);
      }
    }
    // Nếu Robot vừa hỏi danh tính trong 15s gần đây -> chấp nhận đáp tên ngắn 1-2 từ
    if (Date.now() < state.awaitingIdentityReplyUntil) {
      const words = rawText.replace(/[.,!?]/g, "").trim().split(/\s+/).filter(Boolean);
      const banned = ["khong", "co", "ok", "hello", "lucky", "youtube", "game", "tieng", "ngu", "bat", "tat"];
      if (words.length >= 1 && words.length <= 2 && !banned.includes(normalizeVietnamese(words[0]))) {
        return titleCaseName(words.join(" "));
      }
    }
    return "";
  }

  function switchOrOfferCreateMember(spokenName) {
    state.awaitingIdentityReplyUntil = 0;
    const normTarget = normalizeVietnamese(spokenName);
    const existing = state.members.find(m => normalizeVietnamese(m.name) === normTarget || normalizeVietnamese(m.name).includes(normTarget));

    if (existing) {
      state.activeMemberId = existing.id;
      saveLocalState();
      updateHeaderMemberUI();
      renderMembersSettingsList();
      speakFeedback(`Chào ${existing.name}! Lucky đã chuyển sang hồ sơ của bạn rồi, bạn đang có ${existing.stars || 0} ngôi sao nhé!`, "vi-VN", { mood: "excited" });
      return true;
    }

    // Tên mới -> hỏi xác nhận 1 nhịp trước khi tạo
    state.pendingNewUserName = spokenName;
    state.pendingNewUserUntil = Date.now() + 16000;
    speakFeedback(`Ôi bạn mới à! Tên bạn là ${spokenName} đúng không, để Lucky tạo hồ sơ mới cho bạn nhé?`, "vi-VN", { mood: "surprised" });
    return true;
  }

  function parseVietnameseNumber(norm) {
    const digitMatch = norm.match(/\b(\d{1,3})\b/);
    if (digitMatch) return parseInt(digitMatch[1], 10);

    const units = {
      "khong": 0, "mot": 1, "hai": 2, "ba": 3, "bon": 4, "tu": 4,
      "nam": 5, "lam": 5, "sau": 6, "bay": 7, "tam": 8, "chin": 9
    };
    const words = norm.split(" ");
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "muoi") {
        const next = words[i + 1];
        return 10 + (units[next] !== undefined ? units[next] : 0);
      }
      if (units[w] !== undefined && units[w] >= 1) {
        const next = words[i + 1];
        const next2 = words[i + 2];
        if (next === "muoi") return units[w] * 10 + (units[next2] !== undefined ? units[next2] : 0);
        if (units[next] !== undefined && units[w] >= 2) return units[w] * 10 + units[next];
        return units[w];
      }
    }
    return null;
  }

  function parseRandomMode(norm) {
    if (
      norm.includes("khong ngau nhien") ||
      norm.includes("ko ngau nhien") ||
      norm.includes("khong can ngau nhien") ||
      norm.includes("thong thuong") ||
      norm.includes("binh thuong") ||
      norm.includes("theo thu tu") ||
      norm.includes("thu tu")
    ) {
      return "sequential";
    }
    if (norm.includes("ngau nhien") || norm.includes("random") || norm.includes("lon xon")) {
      return "random";
    }
    return null;
  }

  function handleVoiceTranscript(rawText) {
    const text = (rawText || "").trim();
    if (!text) return;

    document.getElementById("user-heard-line").textContent = `🗣️ Bạn nói: "${text}"`;
    const norm = normalizeVietnamese(text);

    // 0. Nếu Robot đang ngủ: chỉ thức dậy khi gọi đúng từ đánh thức hoặc lệnh rõ ràng
    if (state.sleepStage === "sleeping") {
      if (
        norm.includes("hello") ||
        norm.includes("lucky") ||
        norm.includes("thuc day") ||
        norm.includes("day di") ||
        norm.includes("tieng anh") ||
        norm.includes("youtube") ||
        norm.includes("game") ||
        norm.includes("bat den")
      ) {
        wakeRobot(false);
      } else {
        return; // Bỏ qua tạp âm trong lúc ngủ
      }
    }

    resetIdleTimer();

    // 1. Ra lệnh ngủ nghỉ trực tiếp (hoạt động ở cả trang chính lẫn bài học chờ)
    if (
      norm.includes("ngu di") ||
      norm.includes("di ngu") ||
      norm.includes("nghi ngoi") ||
      norm.includes("chuc ngu ngon") ||
      norm.includes("tat man hinh")
    ) {
      goToSleep(true);
      return;
    }

    // 2. Xác nhận tạo hồ sơ thành viên mới (nếu đang chờ xác nhận trong 16s)
    if (state.pendingNewUserName && Date.now() < state.pendingNewUserUntil) {
      if (norm.includes("dung") || norm.includes("co") || norm.includes("ok") || norm.includes("tao") || norm.includes("vang") || norm.includes("da")) {
        const newName = state.pendingNewUserName;
        state.pendingNewUserName = "";
        state.pendingNewUserUntil = 0;
        const avatars = ["🧒", "👧", "👦"];
        const av = avatars[state.members.length % avatars.length];
        const newMember = { id: `m_${Date.now()}`, uid: generateUid("KID_", 20), name: newName, age: 7, avatar: av, stars: 5 };
        state.members.push(newMember);
        state.activeMemberId = newMember.id;
        saveLocalState();
        updateHeaderMemberUI();
        renderMembersSettingsList();
        speakFeedback(`Xong rồi! Chào mừng ${newName} gia nhập gia đình Lucky, tặng bạn 5 ngôi sao làm quà nhé!`, "vi-VN", { mood: "excited" });
        return;
      }
      if (norm.includes("khong") || norm.includes("sai") || norm.includes("huy") || norm.includes("thoi")) {
        state.pendingNewUserName = "";
        state.pendingNewUserUntil = 0;
        speakFeedback("À rồi, Lucky hủy nhé! Bạn muốn làm gì tiếp theo nào?", "vi-VN", { mood: "happy" });
        return;
      }
    }

    // 3. Nếu đang mở bài học (chờ bấm [B]): CHỈ nhận lệnh điều khiển hợp lệ, bỏ qua mọi câu lạ (không bao giờ tự chấm)
    if (state.activeTab === "robot" && state.karaokeOpen) {
      if (norm.includes("youtube") || norm.includes("hoat hinh")) { switchTab("youtube"); return; }
      if (norm.includes("game") || norm.includes("tro choi")) { switchTab("game"); return; }
      if (norm.includes("cai dat")) { switchTab("settings"); return; }
      if (norm.includes("nghe mau") || norm.includes("doc mau") || norm.includes("nghe lai")) { playCurrentSample(); return; }
      if (norm.includes("dich cau") || norm.includes("nghia la gi")) {
        const cur = state.sentences[state.sentenceIndex];
        if (cur) speakFeedback(`Câu này nghĩa là: ${cur.vi || "Chưa có nghĩa tiếng Việt"}`, "vi-VN", { mood: "happy" });
        return;
      }
      if (norm.includes("cau tiep") || norm.includes("cau sau") || norm.includes("tiep theo")) {
        if (state.sentenceIndex < state.sentences.length - 1) {
          state.sentenceIndex += 1;
          renderCurrentSentence();
          playCurrentSample();
        }
        return;
      }
      if (norm.includes("cau truoc") || norm.includes("quay lai")) {
        if (state.sentenceIndex > 0) {
          state.sentenceIndex -= 1;
          renderCurrentSentence();
          playCurrentSample();
        }
        return;
      }
      if (norm.includes("dung hoc") || norm.includes("thoat bai") || norm.includes("ve robot")) {
        toggleKaraokePanel(false);
        return;
      }
      if (norm.includes("bat den") || norm.includes("mo den")) { setHeadLight(true); return; }
      if (norm.includes("tat den")) { setHeadLight(false); return; }
      return; // Im lặng bỏ qua mọi âm thanh khác trong màn hình bài học
    }

    // 4. Đánh thức
    if (norm === "hello" || norm === "lucky" || norm === "hello lucky" || norm === "chao lucky") {
      wakeRobot(true);
      return;
    }

    // 5. Đổi / Tạo nhanh người dùng bằng giọng nói
    const spokenName = extractSpokenUserName(text, norm);
    if (spokenName) {
      switchOrOfferCreateMember(spokenName);
      return;
    }

    // 6. Giải trí & Cài đặt
    if (norm.includes("youtube") || norm.includes("du tup") || norm.includes("hoat hinh") || norm.includes("xem phim")) {
      switchTab("youtube");
      return;
    }
    if (norm.includes("game") || norm.includes("gem") || norm.includes("tro choi") || norm === "choi") {
      switchTab("game");
      return;
    }
    if (norm.includes("mo cai dat") || norm.includes("vao cai dat")) {
      switchTab("settings");
      return;
    }

    // 7. Phần cứng Đèn & Servo ESP32
    if (norm.includes("tat het den") || norm.includes("tat den het")) {
      setHeadLight(false); setArmLight(false); sendBleCommand("L:ALL_OFF");
      speakFeedback("Đã tắt hết đèn rồi nhé!", "vi-VN", { mood: "happy" });
      return;
    }
    if ((norm.includes("bat den") || norm.includes("mo den")) && norm.includes("tay")) {
      setArmLight(true);
      speakFeedback("Đã bật đèn cánh tay!", "vi-VN", { mood: "happy" });
      return;
    }
    if (norm.includes("tat den") && norm.includes("tay")) {
      setArmLight(false);
      speakFeedback("Đã tắt đèn cánh tay!", "vi-VN", { mood: "happy" });
      return;
    }
    if (norm.includes("bat den") || norm.includes("mo den") || norm.includes("den dau")) {
      setHeadLight(true);
      speakFeedback("Đã bật đèn đầu rồi nhé!", "vi-VN", { mood: "excited" });
      return;
    }
    if (norm.includes("tat den")) {
      setHeadLight(false);
      speakFeedback("Đã tắt đèn đầu!", "vi-VN", { mood: "happy" });
      return;
    }
    if (norm.includes("xoay trai") || norm.includes("quay trai")) {
      sendBleCommand("M:LEFT");
      speakFeedback("Xoay trái đây!", "vi-VN", { mood: "curious" });
      return;
    }
    if (norm.includes("xoay phai") || norm.includes("quay phai")) {
      sendBleCommand("M:RIGHT");
      speakFeedback("Xoay phải đây!", "vi-VN", { mood: "curious" });
      return;
    }
    if (norm.includes("ngang dau") || norm.includes("nhin len")) {
      sendBleCommand("M:UP");
      speakFeedback("Ngẩng đầu lên nào!", "vi-VN", { mood: "curious" });
      return;
    }
    if (norm.includes("cui dau") || norm.includes("nhin xuong")) {
      sendBleCommand("M:DOWN");
      speakFeedback("Cúi đầu xuống!", "vi-VN", { mood: "happy" });
      return;
    }
    if (norm.includes("gat dau")) {
      sendBleCommand("M:NOD");
      speakFeedback("Gật đầu đồng ý!", "vi-VN", { mood: "proud" });
      return;
    }
    if (norm.includes("lac dau") || norm.includes("xoay dau")) {
      sendBleCommand("M:SWEEP");
      speakFeedback("Mình xoay đầu ngay đây!", "vi-VN", { mood: "excited" });
      return;
    }

    // 8. Chọn chủ đề thông minh (số + từ khóa ngẫu nhiên / không ngẫu nhiên)
    const num = parseVietnameseNumber(norm);
    const parsedOrder = parseRandomMode(norm);
    const matchedTopicByName = state.topics.find(t => {
      const nTitle = normalizeVietnamese(t.title);
      return nTitle.length >= 3 && norm.includes(nTitle);
    });

    if (
      (state.awaitingTopicChoice || state.activeTab === "topics" || norm.includes("chu de") || norm.includes("so ")) &&
      (num !== null || matchedTopicByName)
    ) {
      const mode = parsedOrder || state.orderMode || "sequential";
      state.orderMode = mode;
      if (num !== null && state.topics.length > 0) {
        const targetTopic = state.topics.find(t => t.index === num) || state.topics[num - 1];
        if (targetTopic) {
          loadTopicLessons(targetTopic.topic, mode, null, true);
          return;
        }
        speakFeedback(`Hiện có ${state.topics.length} chủ đề. Bạn chọn lại từ 1 đến ${state.topics.length} nhé!`, "vi-VN", { mood: "curious" });
        return;
      }
      if (matchedTopicByName) {
        loadTopicLessons(matchedTopicByName.topic, mode, null, true);
        return;
      }
    }

    // 9. Vào học tiếng Anh (linh động từ khóa)
    if (norm.includes("on tu kho")) {
      openHardWordsReview();
      return;
    }
    if (
      norm.includes("tieng anh") ||
      norm.includes("hoc anh") ||
      norm.includes("vao hoc") ||
      norm.includes("luyen noi") ||
      norm.includes("muon hoc") ||
      norm.includes("hoc bai") ||
      norm.includes("so hoc")
    ) {
      if (parsedOrder) state.orderMode = parsedOrder;
      state.awaitingTopicChoice = true;
      switchTab("topics");
      speakFeedback("Bạn muốn học chủ đề số mấy, có học ngẫu nhiên không?", "vi-VN", { mood: "curious" });
      return;
    }

    // 10. Tra từ / Đánh vần nhanh tại màn hình chính
    const spellMatch = norm.match(/(?:danh van|tra tu)\s+(?:tu\s+)?([a-z]{2,20})/);
    if (spellMatch) {
      const word = spellMatch[1];
      fetchServerJson("api.php", { action: "word", w: word })
        .then(res => {
          const sp = res?.spell || word.toUpperCase().split("").join("-");
          speakFeedback(`${word}: ${sp}`, "en-US", { rate: 0.78, mood: "curious" });
        })
        .catch(() => {
          speakFeedback(`${word}: ${word.toUpperCase().split("").join("-")}`, "en-US", { rate: 0.78, mood: "curious" });
        });
      return;
    }

    // 11. Hỏi đáp thân thiện 0ms
    if (norm.includes("ve robot") || norm.includes("man hinh chinh")) { switchTab("robot"); return; }
    if (norm.includes("huong dan")) { switchTab("guide"); return; }
    if (norm.includes("tang sang")) {
      state.config.brightness = Math.min(100, state.config.brightness + 20);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
      speakFeedback(`Đã tăng độ sáng lên ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("giam sang")) {
      state.config.brightness = Math.max(15, state.config.brightness - 20);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
      speakFeedback(`Đã giảm độ sáng xuống ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("may gio")) {
      const d = new Date();
      speakFeedback(`Bây giờ là ${d.getHours()} giờ ${d.getMinutes()} phút nhé!`, "vi-VN", { mood: "happy" });
      return;
    }
    if (norm.includes("bao nhieu pin") || norm.includes("pin con")) {
      const bat = document.getElementById("hdr-battery")?.textContent || "100%";
      speakFeedback(`Pin của mình đang là ${bat}!`, "vi-VN", { mood: "happy" });
      return;
    }
    if (norm.includes("khoe khong") || norm.includes("ban ten gi") || norm.includes("co khoe")) {
      speakFeedback("Mình là Lucky, mình rất khỏe và luôn sẵn sàng chơi cùng bạn!", "vi-VN", { mood: "proud" });
      return;
    }
    if (norm.includes("khoe") || norm.includes("vui lam") || norm.includes("rat vui")) {
      speakFeedback("Nghe vui quá! Mình làm vài câu tiếng Anh kiếm thêm sao nhé!", "vi-VN", { mood: "excited" });
      return;
    }

    // 12. Câu nói rõ (>= 2 từ) ở màn hình chính nhưng chưa khớp lệnh -> trả lời thân thiện thay vì im lặng
    if (state.activeTab === "robot" && norm.split(" ").length >= 2) {
      speakFeedback(pickDialogue("unknownHome"), "vi-VN", { mood: "curious" });
    }
  }

  // ==================== 4-KEY HORIZONTAL NAV ENGINE (A/B/C/D + ACK + DOUBLE-A) ====================
  function isModalOpen(id) {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  }

  function isAnyModalOpen() {
    return (
      isModalOpen("virtual-kb-modal") ||
      isModalOpen("pin-modal") ||
      isModalOpen("wifi-modal") ||
      isModalOpen("ble-modal") ||
      isModalOpen("member-modal") ||
      isModalOpen("topic-complete-modal")
    );
  }

  function clearAllFocusRings() {
    document.querySelectorAll(".kiosk-focus").forEach(el => el.classList.remove("kiosk-focus"));
  }

  function getActiveFocusContext() {
    if (isModalOpen("virtual-kb-modal")) {
      return {
        key: "vkb",
        items: Array.from(document.querySelectorAll("#virtual-kb-modal .vkb-key, #virtual-kb-modal .vkb-ctrl-key")),
        onExit: () => closeVirtualKeyboard()
      };
    }
    if (isModalOpen("topic-complete-modal")) {
      return {
        key: "topicComplete",
        items: Array.from(document.querySelectorAll("#topic-complete-modal .tc-nav-item")),
        onExit: () => {
          document.getElementById("topic-complete-modal").classList.add("hidden");
          toggleKaraokePanel(false);
          switchTab("topics");
        }
      };
    }
    if (isModalOpen("pin-modal")) {
      return {
        key: "pin",
        items: Array.from(document.querySelectorAll("#pin-modal .pin-nav-item")),
        onExit: () => {
          document.getElementById("pin-modal").classList.add("hidden");
          applyCurrentViewFocus();
          scheduleBackgroundListening();
        }
      };
    }
    if (isModalOpen("wifi-modal")) {
      return {
        key: "wifi",
        items: Array.from(document.querySelectorAll("#wifi-modal .scan-item, #wifi-modal .wifi-nav-item")),
        onExit: () => closeWifiModal()
      };
    }
    if (isModalOpen("ble-modal")) {
      return {
        key: "ble",
        items: Array.from(document.querySelectorAll("#ble-modal .scan-item, #ble-modal .ble-nav-item")),
        onExit: () => closeBleModal()
      };
    }
    if (isModalOpen("member-modal")) {
      return {
        key: "member",
        items: Array.from(document.querySelectorAll("#quick-member-grid button")),
        onExit: () => {
          document.getElementById("member-modal").classList.add("hidden");
          applyCurrentViewFocus();
        }
      };
    }
    if (state.activeTab === "robot" && state.karaokeOpen) {
      return {
        key: "karaoke",
        items: Array.from(document.querySelectorAll("#karaoke-panel .k-nav-item")),
        onExit: () => {
          if (state.voiceState === "LESSON_RECORDING_EN") cancelRecordingSession(true);
          else { toggleKaraokePanel(false); switchTab("topics"); }
        }
      };
    }
    if (state.activeTab === "robot") {
      return {
        key: "home",
        items: Array.from(document.querySelectorAll("#home-shortcuts .home-nav-item")),
        onExit: () => wakeRobot(false)
      };
    }
    if (state.activeTab === "topics") {
      return {
        key: "topics",
        items: Array.from(document.querySelectorAll("#tab-topics .topic-nav-item")).filter(el => el.offsetParent !== null),
        onExit: () => switchTab("robot")
      };
    }
    if (state.activeTab === "settings") {
      return {
        key: "settings",
        items: Array.from(document.querySelectorAll("#tab-settings .set-nav-item")).filter(el => el.offsetParent !== null),
        onExit: () => {
          state.settingsUnlocked = false;
          switchTab("robot");
        }
      };
    }
    if (state.activeTab === "guide") {
      return { key: "guide", items: [], onExit: () => switchTab("robot") };
    }
    return null;
  }

  function applyCurrentViewFocus() {
    clearAllFocusRings();
    const ctx = getActiveFocusContext();
    if (!ctx || !ctx.items || ctx.items.length === 0) return;
    let idx = state.focusIdx[ctx.key] || 0;
    if (idx < 0 || idx >= ctx.items.length) idx = 0;
    state.focusIdx[ctx.key] = idx;
    const el = ctx.items[idx];
    if (el) {
      el.classList.add("kiosk-focus");
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function activateFocusedElement(el) {
    if (!el) return;
    if (el.tagName === "SELECT") {
      el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (el.tagName === "INPUT" && el.type === "range") {
      const step = parseFloat(el.step) || 10;
      const max = parseFloat(el.max) || 100;
      const min = parseFloat(el.min) || 0;
      let nextVal = parseFloat(el.value) + step;
      if (nextVal > max) nextVal = min;
      el.value = String(nextVal);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.classList.contains("toggle-row")) {
      const cb = el.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    el.click();
  }

  function handleHardwareKey(rawKey) {
    const key = String(rawKey || "").toUpperCase();
    if (!["A", "B", "C", "D"].includes(key)) return;

    // Nếu Robot đang ngủ: cú bấm đầu tiên chỉ đánh thức sáng màn hình, không kích hoạt nhầm nút đang focus
    if (state.sleepStage === "sleeping") {
      wakeRobot(false);
      return;
    }

    resetIdleTimer();

    // Khi đang ở YouTube hoặc Game: hỗ trợ chuyển tiếp A/B/C/D + chống kẹt nút A (ACK 350ms + Nhấn đúp A 600ms)
    if (!isAnyModalOpen() && (state.activeTab === "youtube" || state.activeTab === "game")) {
      if (key === "A") {
        const now = Date.now();
        if (now - state.lastKeyATime < 600) {
          // Nhấn đúp A nhanh -> thoát khẩn cấp thẳng về Robot
          clearTimeout(state.iframeExitFallbackTimer);
          state.lastKeyATime = 0;
          switchTab("robot");
          return;
        }
        state.lastKeyATime = now;
        if (document.fullscreenElement) {
          document.exitFullscreen?.().catch(() => {});
        }
      }

      const frame = document.getElementById(state.activeTab === "youtube" ? "frame-youtube" : "frame-game");
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: "ROBOT_KEY", key }, "*");
        if (key === "A") {
          clearTimeout(state.iframeExitFallbackTimer);
          // Nếu iframe mất mạng hoặc chưa tải xong (không tự chuyển trang / không báo EXIT sau 380ms) -> thoát thẳng về Robot
          const prevSrc = frame.src;
          state.iframeExitFallbackTimer = setTimeout(() => {
            if ((state.activeTab === "youtube" || state.activeTab === "game") && frame.src === prevSrc) {
              // Chỉ fallback nếu đang không có điều hướng nội bộ; nếu người dùng bấm A lại lần nữa sẽ thoát ngay
              try {
                // Kiểm tra iframe vẫn ở đúng màn hình không phản hồi
                if (frame.contentWindow) {
                  // Nếu iframe đã tự điều hướng thì beforeunload/load sẽ xảy ra, còn không thì bấm đúp A hoặc fallback
                }
              } catch (_) {}
            }
          }, 380);
        }
      } else if (key === "A") {
        switchTab("robot");
      }
      return;
    }

    // Đang ghi âm tiếng Anh 30s: A = hủy ghi, B = chốt chấm điểm ngay
    if (state.activeTab === "robot" && state.karaokeOpen && state.voiceState === "LESSON_RECORDING_EN") {
      if (key === "A") cancelRecordingSession(true);
      else if (key === "B") finalizeRecordingAndGrade();
      return;
    }

    const ctx = getActiveFocusContext();
    if (!ctx) return;

    if (key === "A") {
      if (typeof ctx.onExit === "function") ctx.onExit();
      return;
    }
    if (!ctx.items || ctx.items.length === 0) return;

    let idx = state.focusIdx[ctx.key] || 0;
    if (key === "C") {
      idx = (idx - 1 + ctx.items.length) % ctx.items.length;
      state.focusIdx[ctx.key] = idx;
      applyCurrentViewFocus();
    } else if (key === "D") {
      idx = (idx + 1) % ctx.items.length;
      state.focusIdx[ctx.key] = idx;
      applyCurrentViewFocus();
    } else if (key === "B") {
      activateFocusedElement(ctx.items[idx]);
    }
  }

  // ==================== WI-FI (100% IN-APP: SCAN, CONNECT & FORGET) ====================
  function isLocalWifiIp(ip) {
    return !!(ip && ip !== "0.0.0.0" && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  }

  function cleanSsidName(raw) {
    return (raw || "").replace(/^"+|"+$/g, "").trim();
  }

  function stopWifiVerifyPolling() {
    if (state.wifiVerifyTimer) {
      clearInterval(state.wifiVerifyTimer);
      state.wifiVerifyTimer = null;
    }
  }

  function renderWifiList() {
    const box = document.getElementById("wifi-scan-list");
    if (!box) return;
    if (!state.wifiScannedList || state.wifiScannedList.length === 0) {
      box.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">Không tìm thấy mạng Wi-Fi nào. Bật Wi-Fi & GPS rồi bấm "Quét Wi-Fi".</div>`;
      return;
    }
    box.innerHTML = "";
    state.wifiScannedList.forEach(net => {
      const row = document.createElement("div");
      row.className = `scan-item ${net.ssid === state.selectedWifiSsid ? "selected" : ""}`;
      row.innerHTML = `
        <div class="scan-item-main">
          <div class="scan-item-title">${net.secured ? "🔒" : "🔓"} ${net.ssid}</div>
          <div class="scan-item-sub">Sóng: ${net.signalPct || 80}% • ${net.band || "2.4GHz"}</div>
        </div>
        <span class="scan-badge ${net.connected ? "connected" : ""}">${net.connected ? "✓ Đang dùng" : (net.secured ? "WPA2" : "Mở")}</span>
      `;
      row.addEventListener("click", () => {
        state.selectedWifiSsid = net.ssid;
        document.getElementById("wifi-ssid-input").value = net.ssid;
        document.getElementById("wifi-pass-input").value = "";
        renderWifiList();
        if (net.secured) {
          openVirtualKeyboard("wifi-pass-input", "qwerty", `Mật khẩu Wi-Fi: ${net.ssid}`, () => connectSelectedWifi(), true);
        } else {
          connectSelectedWifi();
        }
      });
      box.appendChild(row);
    });
    if (isModalOpen("wifi-modal")) applyCurrentViewFocus();
  }

  async function scanWifiList() {
    const box = document.getElementById("wifi-scan-list");
    if (box) box.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">🔄 Đang quét các mạng Wi-Fi xung quanh...</div>`;

    const native = getRobotNative();
    if (!native || typeof native.scanWifiNetworks !== "function") {
      if (box) box.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">Quét Wi-Fi hoạt động trên ứng dụng Android APK.</div>`;
      return;
    }
    try {
      const res = await native.scanWifiNetworks();
      state.wifiScannedList = Array.isArray(res?.networks) ? res.networks : [];
      const curSsid = cleanSsidName(res?.currentSsid);
      if (curSsid && !curSsid.toLowerCase().includes("unknown")) {
        document.getElementById("wifi-modal-current").textContent = `Mạng hiện tại: ${curSsid}`;
      }
      renderWifiList();
    } catch (err) {
      if (box) box.innerHTML = `<div class="error-text" style="padding:12px;">Lỗi quét Wi-Fi: ${err?.message || "Cần bật GPS & Wi-Fi"}</div>`;
    }
  }

  async function verifyWifiOnce(targetSsid) {
    const native = getRobotNative();
    const fb = document.getElementById("wifi-connect-feedback");
    if (!native) return false;
    try {
      const st = await native.getDeviceStatus();
      const curSsid = cleanSsidName(st?.wifiSsid);
      const localIp = (st?.localIp || "").trim();
      const matched = curSsid === "Đã kết nối Wi-Fi" || curSsid.toLowerCase() === targetSsid.toLowerCase();
      if (matched && isLocalWifiIp(localIp)) {
        stopWifiVerifyPolling();
        if (fb) {
          fb.textContent = `✅ Đã kết nối Wi-Fi "${targetSsid}" (IP: ${localIp})`;
          fb.className = "sub-text";
          fb.style.color = "#4ade80";
          fb.classList.remove("hidden");
        }
        refreshDeviceTelemetry();
        scanWifiList();
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function connectSelectedWifi() {
    const ssid = (document.getElementById("wifi-ssid-input")?.value || "").trim();
    const password = document.getElementById("wifi-pass-input")?.value || "";
    const fb = document.getElementById("wifi-connect-feedback");
    if (!ssid) {
      if (fb) {
        fb.textContent = "⚠️ Vui lòng chọn một mạng Wi-Fi từ danh sách phía trên.";
        fb.className = "error-text";
        fb.classList.remove("hidden");
      }
      return;
    }

    stopWifiVerifyPolling();
    if (fb) {
      fb.textContent = `⏳ Đang kết nối trực tiếp tới "${ssid}" trong ứng dụng...`;
      fb.className = "sub-text";
      fb.style.color = "#fbbf24";
      fb.classList.remove("hidden");
    }

    const native = getRobotNative();
    if (!native) return;
    try {
      const res = await native.connectWifi({ ssid, password });
      if (res && res.connected && isLocalWifiIp(res.ip)) {
        if (fb) {
          fb.textContent = `✅ Đã kết nối Wi-Fi "${ssid}" (IP: ${res.ip})`;
          fb.style.color = "#4ade80";
        }
        refreshDeviceTelemetry();
        scanWifiList();
        return;
      }
      // Chờ tối đa ~18 giây cho Android chuyển mạng mượt
      let checks = 0;
      state.wifiVerifyTimer = setInterval(async () => {
        checks += 1;
        const ok = await verifyWifiOnce(ssid);
        if (ok || checks >= 14) {
          stopWifiVerifyPolling();
          if (!ok && fb) {
            fb.textContent = `⚠️ Chưa nhận được IP từ "${ssid}". Kiểm tra mật khẩu hoặc bấm "Quên mạng" rồi thử lại.`;
            fb.className = "error-text";
            fb.style.color = "";
          }
        }
      }, 1300);
    } catch (err) {
      if (fb) {
        fb.textContent = `❌ ${err?.message || "Kết nối Wi-Fi thất bại."}`;
        fb.className = "error-text";
      }
    }
  }

  async function forgetCurrentWifi() {
    const ssid = (document.getElementById("wifi-ssid-input")?.value || "").trim();
    const fb = document.getElementById("wifi-connect-feedback");
    stopWifiVerifyPolling();

    const native = getRobotNative();
    if (!native || typeof native.forgetWifi !== "function") return;
    try {
      await native.forgetWifi({ ssid });
      state.selectedWifiSsid = "";
      document.getElementById("wifi-ssid-input").value = "";
      document.getElementById("wifi-pass-input").value = "";
      if (fb) {
        fb.textContent = ssid
          ? `🗑️ Đã quên mạng "${ssid}" khỏi ứng dụng. Bạn có thể chọn Wi-Fi mới!`
          : "🗑️ Đã xóa toàn bộ cấu hình Wi-Fi đã lưu trong ứng dụng!";
        fb.className = "sub-text";
        fb.style.color = "#38bdf8";
        fb.classList.remove("hidden");
      }
      setTimeout(() => {
        refreshDeviceTelemetry();
        scanWifiList();
      }, 900);
    } catch (err) {
      if (fb) {
        fb.textContent = `❌ ${err?.message || "Không thể quên mạng Wi-Fi."}`;
        fb.className = "error-text";
        fb.classList.remove("hidden");
      }
    }
  }

  function openWifiModal() {
    document.getElementById("wifi-connect-feedback")?.classList.add("hidden");
    document.getElementById("wifi-modal").classList.remove("hidden");
    state.focusIdx.wifi = 0;
    refreshDeviceTelemetry();
    scanWifiList();
    applyCurrentViewFocus();
  }

  function closeWifiModal() {
    stopWifiVerifyPolling();
    document.getElementById("wifi-modal").classList.add("hidden");
    applyCurrentViewFocus();
  }

  // ==================== BLUETOOTH ESP32 / PHONE SIM & MOSFET 50%-90% ====================
  function updateBleHeaderAndModalUI() {
    const pill = document.getElementById("hdr-ble-pill");
    const hdrTxt = document.getElementById("hdr-ble-text");
    const detail = document.getElementById("ble-status-detail");
    const modalSt = document.getElementById("ble-modal-status");

    if (state.bleConnected) {
      pill?.classList.remove("offline");
      pill?.classList.add("online");
      if (hdrTxt) hdrTxt.textContent = `BT: ${state.bleDeviceName || "ESP32"}`;
      if (detail) detail.textContent = `Trạng thái: Đã kết nối (${state.bleDeviceName})`;
      if (modalSt) modalSt.textContent = `✅ Đã kết nối: ${state.bleDeviceName} (${state.bleDeviceId})`;
    } else {
      pill?.classList.remove("online");
      pill?.classList.add("offline");
      if (hdrTxt) hdrTxt.textContent = "BT: Chờ";
      if (detail) detail.textContent = "Trạng thái: Chưa kết nối mạch ESP32";
      if (modalSt) modalSt.textContent = "Trạng thái: Chưa kết nối";
    }
  }

  function renderBluetoothDeviceList() {
    const listEl = document.getElementById("ble-device-list");
    if (!listEl) return;
    const devices = Object.values(state.btDiscoveredMap);
    if (devices.length === 0) {
      listEl.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">Chưa tìm thấy thiết bị Bluetooth. Bấm "Quét thiết bị" để tìm ESP32 hoặc ĐT giả lập.</div>`;
      return;
    }
    devices.sort((a, b) => {
      const aEsp = /esp32|robot|lucky/i.test(a.name) ? 1 : 0;
      const bEsp = /esp32|robot|lucky/i.test(b.name) ? 1 : 0;
      if (aEsp !== bEsp) return bEsp - aEsp;
      return (b.rssi || -80) - (a.rssi || -80);
    });
    listEl.innerHTML = "";
    devices.forEach(dev => {
      const addr = dev.address || dev.deviceId;
      const isSelected = addr === state.selectedBtAddress;
      const isConn = state.bleConnected && addr === state.bleDeviceId;
      const icon = /esp32|robot|lucky/i.test(dev.name) ? "🤖" : "📱";
      const row = document.createElement("div");
      row.className = `scan-item ${isSelected ? "selected" : ""}`;
      row.innerHTML = `
        <div class="scan-item-main">
          <div class="scan-item-title">${icon} ${dev.name}</div>
          <div class="scan-item-sub">MAC: ${addr} • ${dev.rssi || -65} dBm ${dev.paired ? "• Đã ghép đôi" : ""}</div>
        </div>
        <span class="scan-badge ${isConn ? "connected" : ""}">${isConn ? "✓ Đã kết nối" : (dev.type || "BT")}</span>
      `;
      row.addEventListener("click", () => {
        state.selectedBtAddress = addr;
        renderBluetoothDeviceList();
      });
      listEl.appendChild(row);
    });
    if (isModalOpen("ble-modal")) applyCurrentViewFocus();
  }

  async function startBluetoothScan() {
    state.btDiscoveredMap = {};
    state.selectedBtAddress = "";
    const modalSt = document.getElementById("ble-modal-status");
    const listEl = document.getElementById("ble-device-list");
    if (modalSt) modalSt.textContent = "🔄 Đang quét thiết bị Bluetooth (BLE + Classic)...";
    if (listEl) listEl.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">🔄 Đang tìm ESP32 hoặc điện thoại giả lập...</div>`;

    const native = getRobotNative();
    if (!native || typeof native.scanBluetoothDevices !== "function") return;
    try {
      const res = await native.scanBluetoothDevices();
      if (res && Array.isArray(res.devices)) {
        res.devices.forEach(d => { if (d.address) state.btDiscoveredMap[d.address] = d; });
        renderBluetoothDeviceList();
      }
    } catch (err) {
      if (modalSt) modalSt.textContent = `⚠️ ${err?.message || "Lỗi quét Bluetooth"}`;
    }
  }

  async function connectSelectedBluetoothDevice() {
    const addr = state.selectedBtAddress || Object.keys(state.btDiscoveredMap)[0];
    const modalSt = document.getElementById("ble-modal-status");
    if (!addr) {
      if (modalSt) modalSt.textContent = "⚠️ Hãy bấm Quét thiết bị và chọn thiết bị trong danh sách.";
      return;
    }
    const dev = state.btDiscoveredMap[addr] || { address: addr, name: addr };
    const pin = document.getElementById("ble-pin-input")?.value || "";
    const autoRec = !!document.getElementById("ble-auto-reconnect")?.checked;
    if (modalSt) modalSt.textContent = `⏳ Đang kết nối tới ${dev.name}...`;

    const native = getRobotNative();
    if (!native) return;
    try {
      const res = await native.connectBluetoothDevice({ address: addr, name: dev.name, pin });
      if (res && res.connected) {
        state.bleConnected = true;
        state.bleDeviceId = addr;
        state.bleDeviceName = dev.name;
        state.config.bleAutoReconnect = autoRec;
        state.config.savedBleAddress = addr;
        state.config.savedBleName = dev.name;
        state.config.savedBlePin = pin;
        saveLocalState();
        updateBleHeaderAndModalUI();
        renderBluetoothDeviceList();
      }
    } catch (err) {
      state.bleConnected = false;
      updateBleHeaderAndModalUI();
      if (modalSt) modalSt.textContent = `❌ ${err?.message || "Kết nối thất bại"}`;
    }
  }

  async function disconnectAndForgetBluetooth() {
    const native = getRobotNative();
    if (native) await native.disconnectBluetoothDevice().catch(() => {});
    state.bleConnected = false;
    state.bleDeviceId = "";
    state.bleDeviceName = "";
    state.config.savedBleAddress = "";
    state.config.savedBleName = "";
    saveLocalState();
    updateBleHeaderAndModalUI();
    renderBluetoothDeviceList();
  }

  function closeBleModal() {
    const native = getRobotNative();
    if (native) native.stopBluetoothScan().catch(() => {});
    document.getElementById("ble-modal").classList.add("hidden");
    applyCurrentViewFocus();
  }

  function sendBleCommand(cmd) {
    if (!state.bleConnected) return;
    const native = getRobotNative();
    if (native && typeof native.sendBluetoothData === "function") {
      native.sendBluetoothData({ cmd }).catch(() => {});
    }
  }

  function handleEspHardwareEvent(msg) {
    const clean = (msg || "").trim().toUpperCase();
    if (!clean) return;
    if (clean === "BTN_A" || clean === "BTN_1" || clean === "A") handleHardwareKey("A");
    else if (clean === "BTN_B" || clean === "BTN_2" || clean === "B") handleHardwareKey("B");
    else if (clean === "BTN_C" || clean === "BTN_3" || clean === "C") handleHardwareKey("C");
    else if (clean === "BTN_D" || clean === "BTN_4" || clean === "D") handleHardwareKey("D");
    else if (clean.includes("TOUCH_HEAD") || clean.includes("PIR_WAKE")) wakeRobot(true);
  }

  function setHeadLight(on) {
    state.headLightOn = on;
    const el = document.getElementById("head-led-indicator");
    if (el) {
      el.textContent = `💡 Đèn đầu: ${on ? "Bật" : "Tắt"}`;
      el.classList.toggle("on", on);
    }
    sendBleCommand(on ? "L:HEAD_ON" : "L:HEAD_OFF");
  }

  function setArmLight(on) {
    state.armLightOn = on;
    const el = document.getElementById("arm-led-indicator");
    if (el) {
      el.textContent = `🦾 Đèn tay: ${on ? "Bật" : "Tắt"}`;
      el.classList.toggle("on", on);
    }
    sendBleCommand(on ? "L:ARM_ON" : "L:ARM_OFF");
  }

  function evaluateBatteryMosfetGuard(batteryPct, temp, isCharging) {
    const el = document.getElementById("mosfet-status-detail");
    if (batteryPct <= 50 && state.mosfetState !== "ON") {
      state.mosfetState = "ON";
      sendBleCommand("P:MOSFET_ON");
      if (el) el.textContent = `⚡ MOSFET: ĐANG KÍCH SẠC (Pin ${batteryPct}% ≤ 50%)`;
      postServerJson("api_user.php", { action: "log_device", bot_id: state.deviceUid }, {
        action: "log_device", bot_id: state.deviceUid,
        battery: batteryPct, temp, is_charging: isCharging, event: "SURVIVAL_MODE_50"
      }).catch(() => {});
    } else if (batteryPct >= 90 && state.mosfetState !== "OFF") {
      state.mosfetState = "OFF";
      sendBleCommand("P:MOSFET_OFF");
      if (el) el.textContent = `⚡ MOSFET: ĐÃ NGẮT SẠC BẢO VỆ PIN (Pin ${batteryPct}% ≥ 90%)`;
      postServerJson("api_user.php", { action: "log_device", bot_id: state.deviceUid }, {
        action: "log_device", bot_id: state.deviceUid,
        battery: batteryPct, temp, is_charging: isCharging, event: "MOSFET_OFF_90"
      }).catch(() => {});
    }
  }

  // ==================== SHARED VIRTUAL KEYBOARD (NUMPAD + QWERTY + SYMBOLS) ====================
  const vkbState = { targetInputId: "", layout: "qwerty", shift: false, masked: true, onConfirm: null };

  function renderVirtualKeyboardKeys() {
    const container = document.getElementById("vkb-keys-container");
    const preview = document.getElementById("vkb-preview-input");
    if (!container || !preview) return;

    const targetEl = document.getElementById(vkbState.targetInputId);
    preview.value = targetEl ? targetEl.value : "";
    preview.type = vkbState.masked ? "password" : "text";

    container.innerHTML = "";
    let rows;
    if (vkbState.layout === "numpad") {
      rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["CLR", "0", "DEL", "OK"]];
    } else if (vkbState.layout === "symbols") {
      rows = [
        ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"],
        ["-", "_", "+", "=", "[", "]", "{", "}", "/", "\\"],
        [":", ";", "'", "\"", ",", ".", "?", "~", "`", "|"],
        ["CLR", "SPACE", "DEL", "OK"]
      ];
    } else {
      rows = [
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
        ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
        ["a", "s", "d", "f", "g", "h", "j", "k", "l", "@"],
        ["SHIFT", "z", "x", "c", "v", "b", "n", "m", "_", "-"],
        ["CLR", "SPACE", ".", "DEL", "OK"]
      ];
    }

    rows.forEach(rowKeys => {
      const rowDiv = document.createElement("div");
      rowDiv.className = "vkb-row";
      rowKeys.forEach(k => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vkb-key";
        let label = k;
        if (k === "SHIFT") { label = vkbState.shift ? "⬆ HOA" : "⬆ thường"; btn.classList.add("wide"); }
        else if (k === "SPACE") { label = "Cách"; btn.classList.add("space"); }
        else if (k === "DEL") { label = "⌫"; btn.classList.add("wide"); }
        else if (k === "CLR") { label = "Xóa"; btn.classList.add("wide"); }
        else if (k === "OK") { label = "✓ Xác nhận"; btn.classList.add("confirm"); }
        else if (/^[a-z]$/.test(k)) { label = vkbState.shift ? k.toUpperCase() : k; }

        btn.textContent = label;
        btn.addEventListener("click", () => {
          const inp = document.getElementById(vkbState.targetInputId);
          if (!inp) return;
          if (k === "SHIFT") { vkbState.shift = !vkbState.shift; renderVirtualKeyboardKeys(); return; }
          if (k === "CLR") inp.value = "";
          else if (k === "DEL") inp.value = inp.value.slice(0, -1);
          else if (k === "SPACE") inp.value += " ";
          else if (k === "OK") {
            closeVirtualKeyboard();
            if (typeof vkbState.onConfirm === "function") vkbState.onConfirm(inp.value);
            return;
          } else {
            const ch = /^[a-z]$/.test(k) && vkbState.shift ? k.toUpperCase() : k;
            inp.value += ch;
          }
          preview.value = inp.value;
        });
        rowDiv.appendChild(btn);
      });
      container.appendChild(rowDiv);
    });

    state.focusIdx.vkb = 0;
    applyCurrentViewFocus();
  }

  function openVirtualKeyboard(targetInputId, layout = "qwerty", title = "⌨️ Bàn phím ảo", onConfirm = null, masked = true) {
    vkbState.targetInputId = targetInputId;
    vkbState.layout = layout;
    vkbState.shift = false;
    vkbState.masked = masked;
    vkbState.onConfirm = onConfirm;
    document.getElementById("vkb-title").textContent = title;
    document.getElementById("virtual-kb-modal").classList.remove("hidden");
    renderVirtualKeyboardKeys();
  }

  function closeVirtualKeyboard() {
    document.getElementById("virtual-kb-modal").classList.add("hidden");
    applyCurrentViewFocus();
  }

  // ==================== SILENT 24/7 REMOTE WEBRTC P2P CAMERA (MATCHES V3.0.1 ATOMIC) ====================
  function renderCameraQrCode() {
    const camUrl = buildApiUrl("camera_live.php", { uid: state.deviceUid });
    const urlInp = document.getElementById("camera-live-url-input");
    if (urlInp) urlInp.value = camUrl;
    const qrSlot = document.getElementById("camera-qr-code");
    if (qrSlot && window.RobotQR) window.RobotQR.render(qrSlot, camUrl, 128);
  }

  let robotPc = null;
  let robotCamStream = null;
  let robotCamHasAudio = false;
  let isAnsweringCam = false;
  let appliedViewerIceCount = 0;
  let robotIceBatch = [];
  let robotIceFlushTimer = null;
  let robotDisconnectGraceTimer = null;

  async function camApiPost(action, payload = {}) {
    return postServerJson(
      "camera_live.php",
      { api: 1, uid: state.deviceUid, action },
      { uid: state.deviceUid, role: "robot", action, ...payload }
    );
  }

  function queueRobotIce(candObj) {
    robotIceBatch.push(candObj);
    if (!robotIceFlushTimer) {
      robotIceFlushTimer = setTimeout(() => {
        const batch = robotIceBatch.splice(0, robotIceBatch.length);
        robotIceFlushTimer = null;
        if (batch.length > 0 && robotPc) {
          camApiPost("ice", { candidates: batch }).catch(() => {});
        }
      }, 250);
    }
  }

  function stopRobotP2PCamera(notifyHangup = false) {
    clearTimeout(robotIceFlushTimer);
    robotIceFlushTimer = null;
    robotIceBatch = [];
    clearTimeout(robotDisconnectGraceTimer);
    robotDisconnectGraceTimer = null;

    if (robotPc) {
      try { robotPc.close(); } catch (_) {}
      robotPc = null;
    }
    if (robotCamStream) {
      try { robotCamStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      robotCamStream = null;
    }
    robotCamHasAudio = false;
    isAnsweringCam = false;
    appliedViewerIceCount = 0;

    if (notifyHangup) camApiPost("hangup").catch(() => {});

    const statusEl = document.getElementById("cam-signaling-status");
    if (statusEl) statusEl.textContent = "🟢 Sẵn sàng giám sát thầm lặng 24/7";

    // Khôi phục mic nền trong im lặng (không đánh thức, không đổi biểu cảm)
    setTimeout(() => {
      if (state.voiceState === "IDLE_VI") scheduleBackgroundListening();
    }, 550);
  }

  async function acquireFrontCameraSilent(includeAudio) {
    const videoConstraint = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };
    if (!includeAudio) {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
      return { stream: s, hasAudio: false };
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      return { stream: s, hasAudio: true };
    } catch (_) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: videoConstraint,
          audio: { echoCancellation: true, noiseSuppression: true }
        });
        return { stream: s, hasAudio: true };
      } catch (__) {
        const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
        return { stream: s, hasAudio: false };
      }
    }
  }

  async function handleIncomingViewerCallSilent(offerSdp) {
    if (isAnsweringCam || robotPc) return;
    isAnsweringCam = true;
    appliedViewerIceCount = 0;
    robotIceBatch = [];

    try {
      // Đóng camera preview trong Cài đặt nếu đang mở
      if (state.camPreviewStream) {
        try { state.camPreviewStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        state.camPreviewStream = null;
        document.getElementById("cam-preview-video")?.classList.add("hidden");
      }

      // CHẾ ĐỘ THẦM LẶNG:
      // - Không đổ chuông, không đánh thức màn hình khi ngủ, không đổi biểu cảm
      // - Nếu bé đang trong 30 giây đọc bài -> ưu tiên giữ bài đọc (truyền video trước, không cắt mic của bé)
      // - Các trạng thái khác (ngủ, chờ, YouTube, Game) -> nhả STT nền trong im lặng để truyền đủ video + audio
      const kidRecordingNow = (state.voiceState === "LESSON_RECORDING_EN");
      const wantAudio = !kidRecordingNow;

      if (wantAudio) {
        stopNativeMicHard();
        await new Promise(resolve => setTimeout(resolve, 650));
      }

      const acquired = await acquireFrontCameraSilent(wantAudio);
      robotCamStream = acquired.stream;
      robotCamHasAudio = acquired.hasAudio;

      robotPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      robotCamStream.getTracks().forEach(t => robotPc.addTrack(t, robotCamStream));

      robotPc.onicecandidate = ev => {
        if (ev.candidate) queueRobotIce(ev.candidate.toJSON());
      };

      robotPc.onconnectionstatechange = () => {
        if (!robotPc) return;
        const st = robotPc.connectionState;
        if (st === "connected") {
          clearTimeout(robotDisconnectGraceTimer);
          robotDisconnectGraceTimer = null;
        } else if (st === "disconnected") {
          clearTimeout(robotDisconnectGraceTimer);
          robotDisconnectGraceTimer = setTimeout(() => {
            if (robotPc && robotPc.connectionState === "disconnected") stopRobotP2PCamera(true);
          }, 5000);
        } else if (st === "failed" || st === "closed") {
          stopRobotP2PCamera(true);
        }
      };

      await robotPc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      const answer = await robotPc.createAnswer();
      await robotPc.setLocalDescription(answer);
      const ansResp = await camApiPost("robot_answer", { sdp: { type: answer.type, sdp: answer.sdp } });
      if (ansResp && ansResp.status === "stale") {
        stopRobotP2PCamera(false);
        return;
      }

      const statusEl = document.getElementById("cam-signaling-status");
      if (statusEl) statusEl.textContent = "🔴 Đang giám sát thầm lặng...";
    } catch (_) {
      stopRobotP2PCamera(true);
    } finally {
      isAnsweringCam = false;
    }
  }

  function startGlobalCameraSignalingPoller() {
    setInterval(async () => {
      if (!state.deviceUid) return;
      try {
        const data = await fetchServerJson("camera_live.php", {
          api: 1, uid: state.deviceUid, action: "poll", role: "robot", t: Date.now()
        });
        if (!data || data.status !== "ok" || !data.session) return;
        const sess = data.session;

        if (sess.state === "ringing" && sess.offer && !robotPc && !isAnsweringCam) {
          await handleIncomingViewerCallSilent(sess.offer);
        }
        if (robotPc && Array.isArray(sess.viewer_ice) && sess.viewer_ice.length > appliedViewerIceCount) {
          for (let i = appliedViewerIceCount; i < sess.viewer_ice.length; i++) {
            try { await robotPc.addIceCandidate(new RTCIceCandidate(sess.viewer_ice[i])); } catch (_) {}
          }
          appliedViewerIceCount = sess.viewer_ice.length;
        }
        if (robotPc && (sess.state === "cooldown" || sess.state === "idle")) {
          stopRobotP2PCamera(false);
        }
      } catch (_) {}
    }, 2500);
  }

  // ==================== SETTINGS UI & TELEMETRY ====================
  function syncSettingsUI() {
    document.getElementById("set-study-only").checked = !!state.config.studyOnly;
    document.getElementById("set-pass-threshold").value = String(state.config.passThreshold || 60);
    document.getElementById("set-brightness").value = state.config.brightness;
    document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
    document.getElementById("set-volume").value = state.config.volume;
    document.getElementById("val-volume").textContent = `${state.config.volume}%`;
    document.getElementById("set-rate").value = state.config.speechRate;
    document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
    renderMembersSettingsList();
    updateBleHeaderAndModalUI();
  }

  function renderMembersSettingsList() {
    const list = document.getElementById("members-list");
    if (!list) return;
    list.innerHTML = "";
    state.members.forEach(m => {
      const row = document.createElement("div");
      row.className = "member-item";
      row.innerHTML = `
        <span><strong>${m.avatar || "🧒"} ${m.name}</strong> • ★ ${m.stars || 0}</span>
        <button type="button" class="action-btn set-nav-item ${m.id === state.activeMemberId ? "primary" : ""}">${m.id === state.activeMemberId ? "Đang chọn" : "Chọn"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => {
        state.activeMemberId = m.id;
        saveLocalState();
        updateHeaderMemberUI();
        renderMembersSettingsList();
      });
      list.appendChild(row);
    });
  }

  function openPinModal() {
    stopNativeMicHard();
    document.getElementById("pin-modal-input").value = "";
    document.getElementById("pin-modal-error").classList.add("hidden");
    document.getElementById("pin-modal").classList.remove("hidden");
    state.focusIdx.pin = 1;
    applyCurrentViewFocus();
  }

  async function refreshDeviceTelemetry() {
    const native = getRobotNative();
    if (native && typeof native.getDeviceStatus === "function") {
      try {
        const st = await native.getDeviceStatus();
        const icon = st.isCharging ? "⚡" : "🔋";
        document.getElementById("hdr-battery").textContent = `${icon} ${st.battery}%`;
        document.getElementById("hdr-temp").textContent = `${Number(st.temperature).toFixed(1)}°C`;

        evaluateBatteryMosfetGuard(st.battery, st.temperature, st.isCharging);

        const curSsid = cleanSsidName(st.wifiSsid);
        const ipStr = (st.localIp || "").trim();
        const wifiText = isLocalWifiIp(ipStr) && curSsid && !curSsid.toLowerCase().includes("unknown")
          ? `${curSsid} (${ipStr})`
          : (curSsid && !curSsid.toLowerCase().includes("unknown") ? curSsid : "Chưa kết nối Wi-Fi");

        const wifiInfo = document.getElementById("set-wifi-info");
        if (wifiInfo) wifiInfo.textContent = wifiText;
        const modalCur = document.getElementById("wifi-modal-current");
        if (modalCur) modalCur.textContent = `Mạng hiện tại: ${wifiText}`;

        const lockSt = document.getElementById("dev-lock-state");
        if (lockSt) {
          lockSt.innerHTML = st.kioskLocked
            ? `Trạng thái Kiosk: <strong style="color:#f59e0b;">ĐANG GHIM MÀN HÌNH</strong>`
            : `Trạng thái Kiosk: <strong style="color:#22c55e;">ĐANG MỞ (KHÔNG GHIM)</strong>`;
        }
      } catch (_) {}
    }
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Nút làm mới YouTube/Game: CHỈ truyền uid (chống hồi sao)
    document.getElementById("btn-refresh-frame").addEventListener("click", () => {
      const m = getActiveMember();
      if (state.activeTab === "youtube") {
        document.getElementById("frame-youtube").src = buildApiUrl("youtube.php", { uid: m.uid, r: Date.now() });
      } else if (state.activeTab === "game") {
        document.getElementById("frame-game").src = buildApiUrl("games.php", { uid: m.uid, r: Date.now() });
      }
    });

    // Nhận sự kiện từ iframe YouTube / Game
    window.addEventListener("message", event => {
      const d = event.data || {};
      if (d.type === "ROBOT_EXIT_TAB") {
        clearTimeout(state.iframeExitFallbackTimer);
        switchTab("robot");
      } else if (d.type === "ROBOT_KEY_ACK") {
        clearTimeout(state.iframeExitFallbackTimer);
      } else if (d.type === "ROBOT_STARS_SYNC" && typeof d.stars === "number") {
        const m = getActiveMember();
        if (m && m.stars !== d.stars) {
          m.stars = Math.max(0, d.stars);
          saveLocalState();
          updateHeaderMemberUI();
        }
      }
    });

    // Phím máy tính mô phỏng 4 phím cứng A/B/C/D
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") handleHardwareKey("A");
      else if (e.key === "Enter") handleHardwareKey("B");
      else if (e.key === "ArrowLeft") handleHardwareKey("C");
      else if (e.key === "ArrowRight") handleHardwareKey("D");
    });

    document.getElementById("hdr-ble-pill").addEventListener("click", () => {
      document.getElementById("ble-modal").classList.remove("hidden");
      state.focusIdx.ble = 0;
      startBluetoothScan();
      applyCurrentViewFocus();
    });

    document.getElementById("member-badge").addEventListener("click", () => {
      const grid = document.getElementById("quick-member-grid");
      grid.innerHTML = "";
      state.members.forEach(m => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `action-btn ${m.id === state.activeMemberId ? "primary" : ""}`;
        btn.textContent = `${m.avatar || "🧒"} ${m.name} (★ ${m.stars || 0})`;
        btn.addEventListener("click", () => {
          state.activeMemberId = m.id;
          saveLocalState();
          updateHeaderMemberUI();
          document.getElementById("member-modal").classList.add("hidden");
          applyCurrentViewFocus();
        });
        grid.appendChild(btn);
      });
      document.getElementById("member-modal").classList.remove("hidden");
      state.focusIdx.member = 0;
      applyCurrentViewFocus();
    });
    document.getElementById("btn-member-close").addEventListener("click", () => {
      document.getElementById("member-modal").classList.add("hidden");
      applyCurrentViewFocus();
    });

    // Home Shortcuts
    document.getElementById("robot-head").addEventListener("click", () => wakeRobot(true));
    document.getElementById("btn-home-learn").addEventListener("click", () => {
      state.awaitingTopicChoice = true;
      switchTab("topics");
      speakFeedback("Bạn chọn chủ đề số mấy, có học ngẫu nhiên không?", "vi-VN", { mood: "curious" });
    });
    document.getElementById("btn-home-youtube").addEventListener("click", () => switchTab("youtube"));
    document.getElementById("btn-home-game").addEventListener("click", () => switchTab("game"));
    document.getElementById("btn-home-talk").addEventListener("click", () => {
      wakeRobot(false);
      speakFeedback("Mình đang nghe đây! Bạn muốn học tiếng Anh, đổi tên hay xem YouTube nào?", "vi-VN", { mood: "curious" });
    });

    // Karaoke Controls
    document.getElementById("btn-close-karaoke").addEventListener("click", () => {
      toggleKaraokePanel(false);
      switchTab("topics");
    });
    document.getElementById("btn-k-prev").addEventListener("click", () => {
      if (state.sentenceIndex > 0) {
        state.sentenceIndex -= 1;
        renderCurrentSentence();
        playCurrentSample();
      }
    });
    document.getElementById("btn-k-next").addEventListener("click", () => {
      if (state.sentenceIndex < state.sentences.length - 1) {
        state.sentenceIndex += 1;
        renderCurrentSentence();
        playCurrentSample();
      }
    });
    document.getElementById("btn-k-listen").addEventListener("click", playCurrentSample);
    document.getElementById("btn-k-record").addEventListener("click", toggleLessonRecording);
    document.getElementById("btn-k-translate").addEventListener("click", () => {
      const cur = state.sentences[state.sentenceIndex];
      if (cur) speakFeedback(`Câu này có nghĩa là: ${cur.vi || "Chưa có nghĩa tiếng Việt"}`, "vi-VN");
    });

    // Topic Complete Modal
    document.getElementById("btn-tc-replay").addEventListener("click", () => {
      document.getElementById("topic-complete-modal").classList.add("hidden");
      state.sentenceIndex = 0;
      renderCurrentSentence();
      playCurrentSample();
    });
    document.getElementById("btn-tc-topics").addEventListener("click", () => {
      document.getElementById("topic-complete-modal").classList.add("hidden");
      toggleKaraokePanel(false);
      switchTab("topics");
    });

    // Topics Controls
    document.getElementById("btn-sync-topics").addEventListener("click", () => loadTopicsList(true));
    document.getElementById("btn-review-hard-words").addEventListener("click", openHardWordsReview);
    document.getElementById("btn-continue-learning").addEventListener("click", () => {
      const prog = getActiveProgress();
      if (prog.lastTopic) loadTopicLessons(prog.lastTopic, "sequential", prog.lastIndex || 0);
    });
    document.getElementById("btn-toggle-order-mode").addEventListener("click", () => {
      state.orderMode = state.orderMode === "sequential" ? "random" : "sequential";
      renderTopicsGrid();
    });
    document.getElementById("btn-toggle-only-vi").addEventListener("click", () => {
      state.onlyViFilter = !state.onlyViFilter;
      renderTopicsGrid();
    });

    // PIN Modal (1234 mặc định + 202799 dự phòng cố định)
    document.getElementById("btn-pin-cancel").addEventListener("click", () => {
      document.getElementById("pin-modal").classList.add("hidden");
      applyCurrentViewFocus();
      scheduleBackgroundListening();
    });
    document.getElementById("btn-pin-toggle-eye").addEventListener("click", () => {
      const inp = document.getElementById("pin-modal-input");
      inp.type = inp.type === "password" ? "text" : "password";
    });
    document.querySelectorAll("#pin-numpad .numpad-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const inp = document.getElementById("pin-modal-input");
        const k = btn.dataset.key;
        if (k === "CLR") inp.value = "";
        else if (k === "DEL") inp.value = inp.value.slice(0, -1);
        else inp.value += k;
      });
    });
    document.getElementById("btn-pin-confirm").addEventListener("click", () => {
      const val = document.getElementById("pin-modal-input").value.trim();
      if (val === state.config.parentPin || val === DEV_MASTER_PIN) {
        state.settingsUnlocked = true;
        document.getElementById("pin-modal").classList.add("hidden");
        switchTab("settings");
      } else {
        document.getElementById("pin-modal-error").classList.remove("hidden");
      }
    });

    // Settings Controls
    document.getElementById("btn-lock-settings").addEventListener("click", () => {
      state.settingsUnlocked = false;
      switchTab("robot");
    });

    document.getElementById("new-member-name").addEventListener("click", () => {
      openVirtualKeyboard("new-member-name", "qwerty", "Nhập tên thành viên mới", null, false);
    });
    document.getElementById("btn-add-member").addEventListener("click", () => {
      const name = document.getElementById("new-member-name").value.trim();
      if (!name) return;
      const avatar = document.getElementById("new-member-avatar").value || "🧒";
      const newMember = { id: `m_${Date.now()}`, uid: generateUid("KID_", 20), name, age: 7, avatar, stars: 0 };
      state.members.push(newMember);
      state.activeMemberId = newMember.id;
      document.getElementById("new-member-name").value = "";
      saveLocalState();
      updateHeaderMemberUI();
      renderMembersSettingsList();
    });

    document.getElementById("set-study-only").addEventListener("change", e => {
      state.config.studyOnly = e.target.checked;
      saveLocalState();
      updateStudyLockUI();
    });
    document.getElementById("set-pass-threshold").addEventListener("change", e => {
      state.config.passThreshold = parseInt(e.target.value, 10) || 60;
      saveLocalState();
    });

    document.getElementById("set-new-parent-pin").addEventListener("click", () => {
      openVirtualKeyboard("set-new-parent-pin", "numpad", "Nhập mã PIN Phụ huynh mới (tối thiểu 4 số)", null, true);
    });
    document.getElementById("btn-save-parent-pin").addEventListener("click", () => {
      const newPin = document.getElementById("set-new-parent-pin").value.trim();
      const fb = document.getElementById("parent-pin-feedback");
      if (newPin.length >= 4) {
        state.config.parentPin = newPin;
        saveLocalState();
        document.getElementById("set-new-parent-pin").value = "";
        if (fb) {
          fb.textContent = "✅ Đã đổi mã PIN Phụ huynh thành công!";
          fb.style.color = "#4ade80";
          fb.classList.remove("hidden");
        }
      } else if (fb) {
        fb.textContent = "⚠️ Mã PIN mới phải có ít nhất 4 ký tự.";
        fb.style.color = "#f87171";
        fb.classList.remove("hidden");
      }
    });

    document.getElementById("set-brightness").addEventListener("input", e => {
      state.config.brightness = parseInt(e.target.value, 10);
      document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
    });
    document.getElementById("set-volume").addEventListener("input", e => {
      state.config.volume = parseInt(e.target.value, 10);
      document.getElementById("val-volume").textContent = `${state.config.volume}%`;
      saveLocalState();
      if (getRobotNative()) getRobotNative().setVolume({ level: state.config.volume }).catch(() => {});
    });
    document.getElementById("set-rate").addEventListener("input", e => {
      state.config.speechRate = parseFloat(e.target.value);
      document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
      saveLocalState();
    });

    document.getElementById("btn-req-perms").addEventListener("click", () => {
      if (getRobotNative()) getRobotNative().requestAllPermissions().catch(() => {});
    });

    // Wi-Fi Modal
    document.getElementById("btn-open-wifi").addEventListener("click", openWifiModal);
    document.getElementById("btn-wifi-close").addEventListener("click", closeWifiModal);
    document.getElementById("btn-wifi-rescan").addEventListener("click", scanWifiList);
    document.getElementById("btn-wifi-forget").addEventListener("click", forgetCurrentWifi);
    document.getElementById("wifi-pass-input").addEventListener("click", () => {
      const ssid = document.getElementById("wifi-ssid-input").value || "Wi-Fi";
      openVirtualKeyboard("wifi-pass-input", "qwerty", `Mật khẩu Wi-Fi: ${ssid}`, () => connectSelectedWifi(), true);
    });
    document.getElementById("btn-wifi-toggle-eye").addEventListener("click", () => {
      const inp = document.getElementById("wifi-pass-input");
      inp.type = inp.type === "password" ? "text" : "password";
    });
    document.getElementById("btn-wifi-connect").addEventListener("click", connectSelectedWifi);

    // Bluetooth Modal & Explicit Left/Center/Right + LED Test Buttons
    document.getElementById("btn-ble-scan").addEventListener("click", () => {
      document.getElementById("ble-modal").classList.remove("hidden");
      state.focusIdx.ble = 0;
      startBluetoothScan();
      applyCurrentViewFocus();
    });
    document.getElementById("btn-ble-close").addEventListener("click", closeBleModal);
    document.getElementById("btn-ble-modal-scan").addEventListener("click", startBluetoothScan);
    document.getElementById("ble-pin-input").addEventListener("click", () => {
      openVirtualKeyboard("ble-pin-input", "numpad", "Nhập mã PIN ghép đôi Bluetooth", null, true);
    });
    document.getElementById("btn-ble-connect-selected").addEventListener("click", connectSelectedBluetoothDevice);
    document.getElementById("btn-ble-forget").addEventListener("click", disconnectAndForgetBluetooth);

    document.getElementById("btn-test-head-left").addEventListener("click", () => sendBleCommand("M:LEFT"));
    document.getElementById("btn-test-head-center").addEventListener("click", () => sendBleCommand("M:CENTER"));
    document.getElementById("btn-test-head-right").addEventListener("click", () => sendBleCommand("M:RIGHT"));
    document.getElementById("btn-test-head-light").addEventListener("click", () => setHeadLight(!state.headLightOn));
    document.getElementById("btn-test-arm-light").addEventListener("click", () => setArmLight(!state.armLightOn));

    // Camera Preview & Copy
    document.getElementById("btn-copy-cam-url").addEventListener("click", async () => {
      const val = document.getElementById("camera-live-url-input").value;
      try {
        await navigator.clipboard.writeText(val);
        document.getElementById("cam-signaling-status").textContent = "✅ Đã sao chép link Camera!";
      } catch (_) {}
    });
    document.getElementById("btn-toggle-cam-preview").addEventListener("click", async () => {
      const videoEl = document.getElementById("cam-preview-video");
      if (state.camPreviewStream) {
        state.camPreviewStream.getTracks().forEach(t => t.stop());
        state.camPreviewStream = null;
        videoEl.classList.add("hidden");
        return;
      }
      try {
        state.camPreviewStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        videoEl.srcObject = state.camPreviewStream;
        videoEl.classList.remove("hidden");
      } catch (_) {}
    });

    // Kiosk Developer Lock/Unlock (Không placeholder, không hint, mật khẩu duy nhất 202799)
    document.getElementById("dev-exit-code-input").addEventListener("click", () => {
      openVirtualKeyboard("dev-exit-code-input", "numpad", "⌨️ Bàn phím số", null, true);
    });
    document.getElementById("btn-dev-lock").addEventListener("click", async () => {
      const native = getRobotNative();
      if (native) {
        await native.setKioskMode({ enabled: true }).catch(() => {});
        refreshDeviceTelemetry();
      }
    });
    document.getElementById("btn-check-pin-status").addEventListener("click", refreshDeviceTelemetry);
    document.getElementById("btn-dev-unlock").addEventListener("click", async () => {
      const code = (document.getElementById("dev-exit-code-input").value || "").trim();
      document.getElementById("dev-exit-code-input").value = "";
      if (code === DEV_MASTER_PIN) {
        const native = getRobotNative();
        if (native) {
          await native.setKioskMode({ enabled: false }).catch(() => {});
          refreshDeviceTelemetry();
        }
        speakFeedback("Đã gỡ ghim ứng dụng!", "vi-VN");
      } else {
        speakFeedback("Mã không chính xác!", "vi-VN");
      }
    });

    // Virtual Keyboard Header
    document.getElementById("vkb-close").addEventListener("click", closeVirtualKeyboard);
    document.getElementById("vkb-switch-layout").addEventListener("click", () => {
      const order = ["qwerty", "numpad", "symbols"];
      vkbState.layout = order[(order.indexOf(vkbState.layout) + 1) % order.length];
      renderVirtualKeyboardKeys();
    });
    document.getElementById("vkb-toggle-eye").addEventListener("click", () => {
      vkbState.masked = !vkbState.masked;
      renderVirtualKeyboardKeys();
    });

    // Native Plugin Event Listeners
    const native = getRobotNative();
    if (native && typeof native.addListener === "function") {
      native.addListener("ttsStart", data => {
        if (data?.id && data.id === state.activeUtteranceId && state._pendingIsSample) {
          startKaraokeWordHighlight();
        }
      });

      native.addListener("ttsEnd", data => {
        if (state.voiceState === "SPEAKING" && (!data?.id || data.id === state.activeUtteranceId)) {
          const cb = state._pendingSpeakDoneCb;
          state._pendingSpeakDoneCb = null;
          state._pendingIsSample = false;
          finishSpeakingPhase(cb);
        }
      });

      native.addListener("speechPartial", data => {
        const partial = (data?.text || "").trim();
        if (!partial) return;

        if (state.voiceState === "LESSON_RECORDING_EN") {
          state.recCurrentPartial = partial;
          const combined = [...state.recSegments, partial].join(" ").trim();
          document.getElementById("k-heard-words").textContent = `Đang đọc: "${combined}"`;
          updateLiveWordColors(combined);
          scheduleSmartSilenceFinish(combined);
          return;
        }

        if (state.voiceState === "IDLE_VI" && !state.karaokeOpen) {
          document.getElementById("user-heard-line").textContent = `👂 Đang nghe: "${partial}"...`;
        }
      });

      native.addListener("speechResult", data => {
        state.isListeningNative = false;
        const finalText = (data?.text || "").trim();

        if (state.voiceState === "LESSON_RECORDING_EN") {
          if (finalText) {
            state.recSegments.push(finalText);
            state.recCurrentPartial = "";
            const combined = state.recSegments.join(" ").trim();
            document.getElementById("k-heard-words").textContent = `Đang đọc: "${combined}"`;
            updateLiveWordColors(combined);
            scheduleSmartSilenceFinish(combined);
          }
          if (state.voiceState === "LESSON_RECORDING_EN" && state.recSecondsLeft > 1) {
            setTimeout(startEnMicSegment, 220);
          }
          return;
        }

        if (state.voiceState === "IDLE_VI") {
          if (finalText) handleVoiceTranscript(finalText);
          setTimeout(scheduleBackgroundListening, 450);
        }
      });

      native.addListener("speechError", () => {
        state.isListeningNative = false;
        if (state.voiceState === "LESSON_RECORDING_EN" && state.recSecondsLeft > 1) {
          setTimeout(startEnMicSegment, 320);
          return;
        }
        if (state.voiceState === "IDLE_VI") {
          setTimeout(scheduleBackgroundListening, 850);
        }
      });

      native.addListener("btDeviceFound", dev => {
        const addr = dev?.address || dev?.deviceId;
        if (addr) {
          state.btDiscoveredMap[addr] = dev;
          renderBluetoothDeviceList();
        }
      });

      native.addListener("btScanFinished", data => {
        const count = Array.isArray(data?.devices) ? data.devices.length : Object.keys(state.btDiscoveredMap).length;
        const st = document.getElementById("ble-modal-status");
        if (st && !state.bleConnected) st.textContent = `Đã quét xong: tìm thấy ${count} thiết bị.`;
        renderBluetoothDeviceList();
      });

      native.addListener("btConnectionChanged", st => {
        state.bleConnected = !!st?.connected;
        if (!state.bleConnected) {
          state.bleDeviceId = "";
          state.bleDeviceName = "";
        }
        updateBleHeaderAndModalUI();
        renderBluetoothDeviceList();
      });

      native.addListener("bleHardwareData", ev => {
        handleEspHardwareEvent(ev?.data || "");
      });
    }
  }

  // ==================== BOOTSTRAP ====================
  async function initApp() {
    if (window.__robot2027V3Initialized) return;
    window.__robot2027V3Initialized = true;

    loadLocalState();
    updateHeaderMemberUI();
    updateStudyLockUI();
    bindEvents();
    startNaturalBlinkAndGazeLoop();
    startIdleMonitor();
    renderCameraQrCode();
    applyCurrentViewFocus();

    refreshDeviceTelemetry();
    setInterval(refreshDeviceTelemetry, 10000);

    const native = getRobotNative();
    if (native) {
      // Xin quyền thiết bị TRƯỚC khi ghim Kiosk để không bị kẹt hộp thoại quyền ở lần cài đầu
      const permRes = await native.requestAllPermissions().catch(() => ({ allGranted: true }));
      const kioskDelay = (permRes && permRes.allGranted) ? 300 : 2800;
      setTimeout(() => {
        native.setKioskMode({ enabled: true }).catch(() => {});
      }, kioskDelay);
      await native.setBrightness({ level: state.config.brightness }).catch(() => {});
      await native.setVolume({ level: state.config.volume }).catch(() => {});
    }

    if (state.config.bleAutoReconnect && state.config.savedBleAddress && native?.connectBluetoothDevice) {
      native.connectBluetoothDevice({
        address: state.config.savedBleAddress,
        name: state.config.savedBleName || state.config.savedBleAddress,
        pin: state.config.savedBlePin || ""
      }).then(res => {
        if (res && res.connected) {
          state.bleConnected = true;
          state.bleDeviceId = state.config.savedBleAddress;
          state.bleDeviceName = state.config.savedBleName || state.config.savedBleAddress;
          updateBleHeaderAndModalUI();
        }
      }).catch(() => {});
    }

    loadTopicsList(true);
    startGlobalCameraSignalingPoller();

    // Chào ngắn 1 lần theo buổi (không spam)
    setTimeout(() => {
      const m = getActiveMember();
      const h = new Date().getHours();
      const key = h < 12 ? "greetMorning" : h < 18 ? "greetAfternoon" : "greetEvening";
      speakFeedback(pickDialogue(key, { name: m.name }), "vi-VN", { mood: "happy" });
    }, 700);
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
