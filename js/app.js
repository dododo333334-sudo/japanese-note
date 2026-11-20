(function () {
  "use strict";

  const state = {
    index: [],
    notes: new Map(),
    current: "",
    query: "",
    notice: "",
  };

  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");
  const noteEl = document.getElementById("note");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search");
  const clearButton = document.getElementById("clear-search");
  const mainEl = document.getElementById("main");
  const FIXED_SITUATIONS = ["招呼用語", "問路與求助", "便利商店", "餐廳", "搭車與買票", "時間與數字"];
  const UNCATEGORIZED = "未分類";
  const speech = {
    supported: typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance === "function",
    voice: null,
    voicesReady: false,
    noticeShown: false,
    dismissed: false,
    activeButton: null,
    utterance: null,
  };
  const SPEECH_NOTICE = "此裝置沒有日文語音，無法播放。iPhone 可到 設定 > 輔助使用 > 朗讀內容 > 聲音 下載日文語音；Android 可在 文字轉語音設定 安裝日文語音資料。";

  setupSpeech();

  searchForm.addEventListener("submit", function (event) {
    event.preventDefault();
  });

  searchInput.addEventListener("input", function () {
    state.query = searchInput.value;
    state.notice = "";
    clearButton.hidden = state.query.trim() === "";
    render();
  });

  clearButton.addEventListener("click", function () {
    resetSearch();
    render();
    searchInput.focus();
  });

  window.addEventListener("hashchange", function () {
    if (state.query) resetSearch();
    state.route = parseRoute();
    render();
    window.scrollTo(0, 0);
  });

  init();

  function setupSpeech() {
    if (!speech.supported) {
      showSpeechNotice();
      return;
    }
    const synth = window.speechSynthesis;
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", refreshVoices);
    } else {
      synth.onvoiceschanged = refreshVoices;
    }
    refreshVoices();
  }

  function refreshVoices() {
    if (!speech.supported) return;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return;
    speech.voicesReady = true;
    speech.voice = pickJapaneseVoice(voices);
    if (!speech.voice) showSpeechNotice();
  }

  function pickJapaneseVoice(voices) {
    const list = voices.filter(function (voice) {
      return voice && typeof voice.lang === "string";
    });
    function langOf(voice) {
      return voice.lang.toLowerCase().replace(/_/g, "-");
    }
    return list.find(function (voice) { return langOf(voice).startsWith("ja-jp"); })
      || list.find(function (voice) { return langOf(voice).startsWith("ja"); })
      || null;
  }

  function showSpeechNotice() {
    if (speech.noticeShown || speech.dismissed) return;
    speech.noticeShown = true;
    const box = document.createElement("div");
    box.className = "speech-notice";
    box.setAttribute("role", "status");
    const text = document.createElement("p");
    text.textContent = SPEECH_NOTICE;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "關閉";
    close.addEventListener("click", function () {
      speech.dismissed = true;
      box.remove();
    });
    box.append(text, close);
    mainEl.insertBefore(box, mainEl.firstChild);
  }

  function createSpeakButton(japanese) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speak";
    button.setAttribute("aria-label", "播放日文發音");
    button.setAttribute("aria-pressed", "false");
    button.dataset.jp = japanese;
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🔊";
    button.appendChild(icon);
    button.addEventListener("click", speakJapanese);
    return button;
  }

  function speakJapanese(event) {
    const button = event.currentTarget;
    const text = button.dataset.jp || "";
    if (!speech.supported) {
      showSpeechNotice();
      return;
    }
    const synth = window.speechSynthesis;
    if (speech.activeButton === button) {
      stopSpeech();
      return;
    }
    const voices = synth.getVoices() || [];
    if (voices.length) {
      speech.voicesReady = true;
      speech.voice = pickJapaneseVoice(voices);
      if (!speech.voice) {
        showSpeechNotice();
        return;
      }
    }
    const previous = speech.activeButton;
    setPlaying(button);
    if (previous) synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 0.8;
    if (speech.voice) utterance.voice = speech.voice;
    function stillCurrent() {
      return speech.utterance === utterance && speech.activeButton === button;
    }
    utterance.onend = function () {
      if (stillCurrent()) setPlaying(null);
    };
    utterance.onerror = function () {
      if (stillCurrent()) setPlaying(null);
    };
    speech.utterance = utterance;
    synth.speak(utterance);
  }

  function setPlaying(button) {
    if (speech.activeButton && speech.activeButton !== button) {
      speech.activeButton.classList.remove("is-playing");
      speech.activeButton.setAttribute("aria-pressed", "false");
    }
    speech.activeButton = button;
    if (!button) {
      speech.utterance = null;
      return;
    }
    button.classList.add("is-playing");
    button.setAttribute("aria-pressed", "true");
  }

  function stopSpeech() {
    const synth = speech.supported ? window.speechSynthesis : null;
    const shouldCancel = Boolean(speech.activeButton || speech.utterance);
    setPlaying(null);
    if (synth && shouldCancel) synth.cancel();
  }

  async function init() {
    if (location.protocol === "file:") {
      setStatus("請用網頁伺服器開啟這個網站，不要直接點開檔案。");
      return;
    }
    try {
      const index = await fetchJson("notes/index.json");
      if (!Array.isArray(index)) throw new Error("index");
      state.index = index.slice().sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date));
      });
      await Promise.all(state.index.map(async function (item) {
        const note = await fetchJson("notes/" + item.date + ".json");
        state.notes.set(item.date, note);
      }));
      if (!state.index.length) {
        setStatus("尚無筆記。");
        return;
      }
      buildCatalog();
      state.route = parseRoute();
      if (!location.hash) history.replaceState(null, "", "#home");
      render();
    } catch (error) {
      setStatus("無法載入筆記。");
    }
  }

  function pageBase() {
    const url = new URL(document.baseURI);
    if (url.pathname.endsWith("/index.html")) {
      url.pathname = url.pathname.slice(0, -"index.html".length);
    } else if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function fetchJson(path) {
    return fetch(new URL(path, pageBase())).then(function (response) {
      if (!response.ok) throw new Error(path);
      return response.json();
    });
  }

  function resetSearch() {
    searchInput.value = "";
    state.query = "";
    clearButton.hidden = true;
  }

  function parseRoute() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw || raw === "home") return { page: "home", situation: "" };
    if (raw === "mistakes") return { page: "mistakes", situation: "" };
    if (raw.indexOf("c/") === 0) {
      let name = raw.slice(2);
      try { name = decodeURIComponent(name); } catch (error) { /* keep raw */ }
      return { page: "category", situation: name };
    }
    return { page: "home", situation: "" };
  }

  function routeHash(route) {
    if (!route || route.page === "home") return "#home";
    if (route.page === "mistakes") return "#mistakes";
    return "#c/" + encodeURIComponent(route.situation);
  }

  function navigate(route) {
    state.notice = "";
    resetSearch();
    state.route = route;
    const hash = routeHash(route);
    if (location.hash !== hash) {
      location.hash = hash;
      return;
    }
    render();
    window.scrollTo(0, 0);
  }

  function buildCatalog() {
    const buckets = new Map();
    const extra = [];
    function bucketFor(name) {
      if (!buckets.has(name)) {
        buckets.set(name, { patterns: [], grammar: [], vocabulary: [], examples: [] });
        if (FIXED_SITUATIONS.indexOf(name) === -1 && name !== UNCATEGORIZED) extra.push(name);
      }
      return buckets.get(name);
    }
    FIXED_SITUATIONS.forEach(bucketFor);
    state.mistakes = [];
    state.index.forEach(function (item) {
      const note = state.notes.get(item.date);
      if (!note) return;
      addEntries(bucketFor, "patterns", note.patterns, item.date);
      addEntries(bucketFor, "grammar", note.grammar, item.date);
      addEntries(bucketFor, "vocabulary", note.vocabulary, item.date);
      addEntries(bucketFor, "examples", note.examples, item.date);
      (note.corrections || []).forEach(function (entry) {
        state.mistakes.push({ item: entry, date: item.date });
      });
    });
    state.mistakes.sort(function (a, b) { return b.date.localeCompare(a.date); });
    const names = FIXED_SITUATIONS.concat(extra);
    if ((buckets.get(UNCATEGORIZED) || { patterns: [] }).patterns.length
      || entryCount(buckets.get(UNCATEGORIZED))) {
      names.push(UNCATEGORIZED);
    }
    state.catalog = names.filter(function (name) {
      return name === UNCATEGORIZED ? entryCount(buckets.get(name)) > 0 : buckets.has(name);
    }).map(function (name) {
      return { name: name, groups: buckets.get(name) };
    });
  }

  function addEntries(bucketFor, kind, entries, date) {
    (entries || []).forEach(function (entry) {
      const name = entry.situation || UNCATEGORIZED;
      const bucket = bucketFor(name);
      const key = dedupeKey(kind, entry);
      const existing = bucket[kind].find(function (row) { return row.key === key; });
      if (existing) {
        if (existing.dates.indexOf(date) === -1) existing.dates.push(date);
        return;
      }
      bucket[kind].push({ key: key, item: entry, dates: [date] });
    });
  }

  function dedupeKey(kind, entry) {
    if (kind === "grammar") {
      const examples = (entry.examples || []).map(function (example) {
        return [example.jp, example.reading, example.zh].join("\u0001");
      }).join("\u0002");
      return [entry.point, entry.explanation, examples].join("\u0000");
    }
    return [entry.jp, entry.reading, entry.zh].join("\u0000");
  }

  function entryCount(groups) {
    if (!groups) return 0;
    return groups.patterns.length + groups.grammar.length + groups.vocabulary.length + groups.examples.length;
  }

  function sortedRows(rows) {
    return rows.slice().sort(function (a, b) {
      const left = a.dates.slice().sort().pop();
      const right = b.dates.slice().sort().pop();
      return right.localeCompare(left);
    });
  }

  function render() {
    if (speech.activeButton) stopSpeech();
    const query = state.query.trim();
    if (query) {
      noteEl.hidden = true;
      noteEl.replaceChildren();
      const found = searchNotes(query);
      renderResults(found, query);
      document.title = "搜尋｜日語筆記";
      if (!found.length) setStatus("找不到符合「" + query + "」的內容。");
      else {
        const count = found.reduce(function (sum, group) { return sum + group.hits.length; }, 0);
        setStatus("找到 " + count + " 筆。");
      }
      return;
    }
    resultsEl.replaceChildren();
    hideStatus();
    noteEl.hidden = false;
    const route = state.route || { page: "home" };
    if (route.page === "mistakes") {
      renderMistakes();
      document.title = "我常犯的錯｜日語筆記";
      return;
    }
    if (route.page === "category") {
      const category = (state.catalog || []).find(function (item) { return item.name === route.situation; });
      if (!category) {
        noteEl.replaceChildren();
        setStatus("沒有「" + route.situation + "」這個情境。");
        document.title = "日語筆記";
        return;
      }
      renderCategory(category);
      document.title = category.name + "｜日語筆記";
      return;
    }
    renderHome();
    document.title = "日語筆記";
  }

  function renderHome() {
    noteEl.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "home-intro";
    intro.textContent = "依情境複習。點一個情境，看裡面的句型、文法和單字。";
    const list = document.createElement("ul");
    list.className = "situation-list";
    (state.catalog || []).forEach(function (category) {
      const count = entryCount(category.groups);
      if (category.name !== UNCATEGORIZED && FIXED_SITUATIONS.indexOf(category.name) === -1 && count === 0) return;
      if (category.name === UNCATEGORIZED && count === 0) return;
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "situation-card";
      const name = document.createElement("span");
      name.textContent = category.name;
      const meta = document.createElement("span");
      meta.className = "situation-count";
      meta.textContent = count + " 項";
      button.append(name, meta);
      button.addEventListener("click", function () {
        navigate({ page: "category", situation: category.name });
      });
      li.appendChild(button);
      list.appendChild(li);
    });
    noteEl.append(intro, list);
  }

  function renderCategory(category) {
    noteEl.replaceChildren();
    const title = document.createElement("h2");
    title.className = "situation-title";
    title.textContent = category.name;
    noteEl.appendChild(title);
    const groups = category.groups;
    appendGroup("句型", sortedRows(groups.patterns), "stack", function (row) {
      return renderPhrase(row.item, "", "phrase", row.dates);
    });
    appendGroup("文法", sortedRows(groups.grammar), "stack", function (row) {
      return renderGrammar(row.item, "", row.dates);
    });
    appendGroup("單字", sortedRows(groups.vocabulary), "vocab-list", function (row) {
      return renderPhrase(row.item, "", "phrase", row.dates);
    });
    appendGroup("例句", sortedRows(groups.examples), "stack", function (row) {
      return renderPhrase(row.item, "", "phrase example", row.dates);
    });
  }

  function appendGroup(title, rows, className, renderRow) {
    if (!rows.length) return;
    noteEl.appendChild(sectionBlock(title, rows.map(renderRow), className));
  }

  function renderMistakes() {
    noteEl.replaceChildren();
    const title = document.createElement("h2");
    title.className = "situation-title";
    title.textContent = "我常犯的錯";
    noteEl.appendChild(title);
    if (!state.mistakes.length) {
      const empty = document.createElement("p");
      empty.className = "home-intro";
      empty.textContent = "目前沒有錯誤訂正。";
      noteEl.appendChild(empty);
      return;
    }
    const list = document.createElement("div");
    list.className = "stack";
    state.mistakes.forEach(function (row) {
      const card = renderCorrection(row.item, "");
      card.appendChild(renderDates([row.date]));
      list.appendChild(card);
    });
    noteEl.appendChild(list);
  }

  function renderDates(dates) {
    const label = document.createElement("p");
    label.className = "item-date";
    label.textContent = dates.slice().sort().reverse().map(formatMonthDay).join(" · ");
    return label;
  }

  function formatMonthDay(iso) {
    const parts = String(iso).split("-");
    return Number(parts[1]) + "/" + Number(parts[2]);
  }

  function renderNote(note) {
    noteEl.replaceChildren();
    noteEl.appendChild(renderHeading(note));
    noteEl.appendChild(sectionBlock("句型", note.patterns.map(function (item) {
      return renderPhrase(item, "", "phrase");
    }), "stack"));
    if (note.grammar && note.grammar.length) {
      noteEl.appendChild(sectionBlock("文法", note.grammar.map(function (item) {
        return renderGrammar(item, "");
      }), "stack"));
    }
    noteEl.appendChild(sectionBlock("單字", note.vocabulary.map(function (item) {
      return renderPhrase(item, "", "phrase");
    }), "vocab-list"));
    if (note.examples && note.examples.length) {
      noteEl.appendChild(sectionBlock("例句", note.examples.map(function (item) {
        return renderPhrase(item, "", "phrase example");
      }), "stack"));
    }
    if (note.corrections && note.corrections.length) {
      noteEl.appendChild(sectionBlock("錯誤訂正", note.corrections.map(function (item) {
        return renderCorrection(item, "");
      }), "stack"));
    }
  }

  function renderHeading(note) {
    const header = document.createElement("header");
    header.className = "note-head";
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "主題";
    const title = document.createElement("h2");
    title.className = "topic";
    title.textContent = note.topic;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = formatLong(note.date);
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = summarize(note);
    header.append(eyebrow, title, meta, summary);
    return header;
  }

  function summarize(note) {
    const parts = [
      note.patterns.length + " 個句型",
      note.vocabulary.length + " 個單字",
    ];
    if (note.grammar && note.grammar.length) parts.push(note.grammar.length + " 個文法");
    if (note.examples && note.examples.length) parts.push(note.examples.length + " 個例句");
    if (note.corrections && note.corrections.length) parts.push(note.corrections.length + " 則訂正");
    return parts.join(" · ");
  }

  function sectionBlock(title, nodes, className) {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.className = "section-title";
    heading.textContent = title;
    const list = document.createElement("div");
    list.className = className;
    nodes.forEach(function (node) { list.appendChild(node); });
    section.append(heading, list);
    return section;
  }

  function renderPhrase(item, query, className, dates) {
    const card = document.createElement("article");
    card.className = "card " + className;
    const line = document.createElement("div");
    line.className = "jp-line";
    const jp = document.createElement("p");
    jp.className = "jp";
    jp.lang = "ja";
    if (item.segments && item.segments.length) {
      renderSegments(jp, item.segments, query);
    } else {
      appendHighlighted(jp, item.jp, query);
    }
    line.append(jp, createSpeakButton(item.jp));
    card.appendChild(line);
    if (!(item.segments && item.segments.length) && !sameText(item.jp, item.reading)) {
      const reading = document.createElement("p");
      reading.className = "reading";
      reading.lang = "ja";
      appendHighlighted(reading, item.reading, query);
      card.appendChild(reading);
    }
    const zh = document.createElement("p");
    zh.className = "zh";
    zh.lang = "zh-Hant";
    appendHighlighted(zh, item.zh, query);
    card.appendChild(zh);
    if (dates && dates.length) card.appendChild(renderDates(dates));
    return card;
  }

  function renderSegments(parent, segments, query) {
    segments.forEach(function (segment) {
      if (!segment.r) {
        appendHighlighted(parent, segment.t, query);
        return;
      }
      const ruby = document.createElement("ruby");
      appendHighlighted(ruby, segment.t, query);
      const rt = document.createElement("rt");
      appendHighlighted(rt, segment.r, query);
      ruby.appendChild(rt);
      parent.appendChild(ruby);
    });
  }

  function renderGrammar(item, query, dates) {
    const card = document.createElement("article");
    card.className = "card grammar";
    const point = document.createElement("h4");
    point.className = "grammar-point";
    appendHighlighted(point, item.point, query);
    const explanation = document.createElement("p");
    explanation.className = "grammar-explain";
    appendHighlighted(explanation, item.explanation, query);
    card.append(point, explanation);
    (item.examples || []).forEach(function (example) {
      card.appendChild(renderGrammarExample(example, query));
    });
    if (dates && dates.length) card.appendChild(renderDates(dates));
    return card;
  }

  function renderGrammarExample(example, query) {
    const block = document.createElement("div");
    block.className = "grammar-example";
    const line = document.createElement("div");
    line.className = "jp-line";
    const jp = document.createElement("p");
    jp.className = "jp";
    jp.lang = "ja";
    if (example.segments && example.segments.length) {
      renderSegments(jp, example.segments, query);
    } else {
      appendHighlighted(jp, example.jp, query);
    }
    line.append(jp, createSpeakButton(example.jp));
    block.appendChild(line);
    if (!(example.segments && example.segments.length) && example.reading && !sameText(example.jp, example.reading)) {
      const reading = document.createElement("p");
      reading.className = "reading";
      reading.lang = "ja";
      appendHighlighted(reading, example.reading, query);
      block.appendChild(reading);
    }
    if (example.zh) {
      const zh = document.createElement("p");
      zh.className = "zh";
      zh.lang = "zh-Hant";
      appendHighlighted(zh, example.zh, query);
      block.appendChild(zh);
    }
    return block;
  }

  function renderCorrection(item, query) {
    const card = document.createElement("article");
    card.className = "card correction";
    card.append(
      panel("錯誤", item.wrong, "panel-wrong", query),
      changeLabel(),
      panel("正確", item.correct, "panel-correct", query)
    );
    const explain = document.createElement("p");
    explain.className = "explain";
    explain.lang = "zh-Hant";
    appendHighlighted(explain, item.explanation, query);
    card.appendChild(explain);
    return card;
  }

  function panel(tagText, value, className, query) {
    const wrap = document.createElement("div");
    wrap.className = "panel " + className;
    const tag = document.createElement("p");
    tag.className = "tag";
    tag.textContent = tagText;
    const jp = document.createElement("p");
    jp.className = "jp";
    jp.lang = "ja";
    appendHighlighted(jp, value, query);
    wrap.append(tag, jp);
    return wrap;
  }

  function changeLabel() {
    const label = document.createElement("p");
    label.className = "change-label";
    label.textContent = "改為";
    return label;
  }

  function renderResults(groups, query) {
    resultsEl.replaceChildren();
    groups.forEach(function (group) {
      const article = document.createElement("article");
      article.className = "result";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-jump";
      button.textContent = group.situation + "　" + formatMonthDay(group.date);
      button.addEventListener("click", function () {
        state.notice = "";
        resetSearch();
        if (group.kind === "錯誤訂正") navigate({ page: "mistakes", situation: "" });
        else navigate({ page: "category", situation: group.situation });
      });
      const hits = document.createElement("div");
      hits.className = "hits";
      group.hits.forEach(function (hit) {
        const block = document.createElement("div");
        const kind = document.createElement("p");
        kind.className = "kind";
        kind.textContent = hit.kind;
        block.appendChild(kind);
        if (hit.kind === "主題") {
          const topic = document.createElement("p");
          topic.className = "zh";
          appendHighlighted(topic, hit.text, query);
          block.appendChild(topic);
        } else if (hit.kind === "錯誤訂正") {
          block.appendChild(renderCorrection(hit.item, query));
        } else if (hit.kind === "文法") {
          block.appendChild(renderGrammar(hit.item, query, [group.date]));
        } else {
          block.appendChild(renderPhrase(hit.item, query, "phrase", [group.date]));
        }
        hits.appendChild(block);
      });
      article.append(button, hits);
      resultsEl.appendChild(article);
    });
  }

  function searchNotes(query) {
    const groups = [];
    state.index.slice().reverse().forEach(function (item) {
      const note = state.notes.get(item.date);
      if (!note) return;
      const hits = [];
      if (matches(note.topic, query)) hits.push({ kind: "主題", text: note.topic });
      note.patterns.forEach(function (entry) {
        if (matches(entry.jp, query) || matches(entry.reading, query) || matches(entry.zh, query)) {
          hits.push({ kind: "句型", item: entry });
        }
      });
      note.vocabulary.forEach(function (entry) {
        if (matches(entry.jp, query) || matches(entry.reading, query) || matches(entry.zh, query)) {
          hits.push({ kind: "單字", item: entry });
        }
      });
      (note.examples || []).forEach(function (entry) {
        if (matches(entry.jp, query) || matches(entry.reading, query) || matches(entry.zh, query)) {
          hits.push({ kind: "例句", item: entry });
        }
      });
      (note.grammar || []).forEach(function (entry) {
        const inPoint = matches(entry.point, query) || matches(entry.explanation, query);
        const inExample = (entry.examples || []).some(function (example) {
          return matches(example.jp, query) || matches(example.reading, query) || matches(example.zh, query);
        });
        if (inPoint || inExample) hits.push({ kind: "文法", item: entry });
      });
      (note.corrections || []).forEach(function (entry) {
        if (matches(entry.wrong, query) || matches(entry.correct, query) || matches(entry.explanation, query)) {
          hits.push({ kind: "錯誤訂正", item: entry });
        }
      });
      hits.forEach(function (hit) {
        groups.push({
          date: note.date,
          topic: note.topic,
          situation: hit.kind === "錯誤訂正" ? "我常犯的錯" : ((hit.item && hit.item.situation) || note.situation || UNCATEGORIZED),
          kind: hit.kind,
          hits: [hit],
        });
      });
    });
    return groups;
  }

  function matches(text, query) {
    return String(text || "").toLowerCase().includes(query.trim().toLowerCase());
  }

  function sameText(a, b) {
    return String(a || "").normalize("NFC").trim() === String(b || "").normalize("NFC").trim();
  }

  function appendHighlighted(parent, text, query) {
    const source = String(text || "");
    const needle = String(query || "").trim().toLowerCase();
    const haystack = source.toLowerCase();
    if (!needle || haystack.length !== source.length || needle.length !== String(query || "").trim().length) {
      parent.appendChild(document.createTextNode(source));
      return;
    }
    let cursor = 0;
    while (cursor < haystack.length) {
      const at = haystack.indexOf(needle, cursor);
      if (at < 0) {
        parent.appendChild(document.createTextNode(source.slice(cursor)));
        break;
      }
      if (at > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, at)));
      const mark = document.createElement("mark");
      mark.textContent = source.slice(at, at + needle.length);
      parent.appendChild(mark);
      cursor = at + needle.length;
    }
  }

  function formatShort(iso) {
    const parts = iso.split("-").map(Number);
    return parts[1] + "月" + parts[2] + "日";
  }

  function formatLong(iso) {
    const parts = iso.split("-").map(Number);
    const weekday = "日一二三四五六"[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
    return parts[0] + "年" + parts[1] + "月" + parts[2] + "日（週" + weekday + "）";
  }

  function setStatus(text) {
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.textContent = "";
  }
})();
