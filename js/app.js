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
  const prevButton = document.getElementById("prev-day");
  const nextButton = document.getElementById("next-day");
  const currentDay = document.getElementById("current-day");
  const dateList = document.getElementById("date-list");
  const mainEl = document.getElementById("main");
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

  prevButton.addEventListener("click", function () {
    step(-1);
  });

  nextButton.addEventListener("click", function () {
    step(1);
  });

  window.addEventListener("hashchange", function () {
    const requested = dateFromHash();
    if (!requested) {
      const newest = newestDate();
      if (newest) openDate(newest, { replace: true });
      return;
    }
    if (!state.notes.has(requested)) {
      state.notice = "沒有 " + requested + " 的筆記，已改顯示最新的一天。";
      const newest = newestDate();
      if (newest) openDate(newest, { replace: true });
      else render();
      return;
    }
    if (requested === state.current && !state.query) return;
    openDate(requested);
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
      const requested = dateFromHash();
      if (!state.index.length) {
        setStatus("尚無筆記。");
        return;
      }
      if (requested && !state.notes.has(requested)) {
        state.notice = "沒有 " + requested + " 的筆記，已改顯示最新的一天。";
      }
      openDate(state.notes.has(requested) ? requested : newestDate(), { replace: true });
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

  function newestDate() {
    return state.index.length ? state.index[state.index.length - 1].date : "";
  }

  function dateFromHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch (error) {
      return raw;
    }
  }

  function dates() {
    return state.index.map(function (item) { return item.date; });
  }

  function resetSearch() {
    searchInput.value = "";
    state.query = "";
    clearButton.hidden = true;
  }

  function step(delta) {
    const list = dates();
    const target = list[list.indexOf(state.current) + delta];
    if (!target) return;
    state.notice = "";
    resetSearch();
    openDate(target);
  }

  function openDate(date, options) {
    const replace = options && options.replace;
    if (!state.notes.has(date)) {
      render();
      return;
    }
    state.current = date;
    if (dateFromHash() !== date) {
      if (replace) history.replaceState(null, "", "#" + date);
      else location.hash = date;
    }
    render();
    const active = dateList.querySelector('[aria-current="date"]');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ inline: "center", block: "nearest" });
    }
  }

  function render() {
    if (speech.activeButton) stopSpeech();
    renderDateList();
    renderSwitcher();
    const query = state.query.trim();
    if (query) {
      noteEl.hidden = true;
      noteEl.replaceChildren();
      const found = searchNotes(query);
      renderResults(found, query);
      document.title = "搜尋｜日語筆記";
      if (!found.length) {
        setStatus("找不到符合「" + query + "」的內容。");
      } else {
        const count = found.reduce(function (sum, group) { return sum + group.hits.length; }, 0);
        setStatus("找到 " + count + " 筆。");
      }
      return;
    }
    resultsEl.replaceChildren();
    if (!state.current || !state.notes.has(state.current)) {
      noteEl.hidden = true;
      setStatus(state.index.length ? "尚無筆記。" : "尚無筆記。");
      return;
    }
    if (state.notice) setStatus(state.notice);
    else hideStatus();
    noteEl.hidden = false;
    renderNote(state.notes.get(state.current));
    const note = state.notes.get(state.current);
    document.title = note.date + " " + note.topic + "｜日語筆記";
  }

  function renderSwitcher() {
    const list = dates();
    const index = list.indexOf(state.current);
    prevButton.disabled = index <= 0;
    nextButton.disabled = index === -1 || index >= list.length - 1;
    currentDay.replaceChildren();
    if (index === -1) return;
    const note = state.notes.get(state.current);
    const date = document.createElement("p");
    date.className = "current-date";
    date.textContent = formatShort(state.current);
    const topic = document.createElement("p");
    topic.className = "current-topic";
    topic.textContent = note ? note.topic : "";
    currentDay.append(date, topic);
  }

  function renderDateList() {
    dateList.replaceChildren();
    state.index.forEach(function (item) {
      const note = state.notes.get(item.date);
      const topic = note ? note.topic : item.topic;
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "date-chip";
      if (item.date === state.current) {
        button.setAttribute("aria-current", "date");
      }
      button.setAttribute("aria-label", item.date + " " + topic);
      const date = document.createElement("span");
      date.className = "chip-date";
      date.textContent = item.date;
      const label = document.createElement("span");
      label.className = "chip-topic";
      label.textContent = topic;
      button.append(date, label);
      button.addEventListener("click", function () {
        state.notice = "";
        resetSearch();
        openDate(item.date);
        window.scrollTo(0, 0);
      });
      li.appendChild(button);
      dateList.appendChild(li);
    });
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

  function renderPhrase(item, query, className) {
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

  function renderGrammar(item, query) {
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
      button.textContent = formatLong(group.date) + "　" + group.topic;
      button.addEventListener("click", function () {
        state.notice = "";
        resetSearch();
        openDate(group.date);
        window.scrollTo(0, 0);
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
          block.appendChild(renderGrammar(hit.item, query));
        } else {
          block.appendChild(renderPhrase(hit.item, query, "phrase"));
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
      if (hits.length) groups.push({ date: note.date, topic: note.topic, hits: hits });
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
