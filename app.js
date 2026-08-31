const { useState, useEffect, useRef, useCallback } = React;

// 組み込みの既定値（秒 / 回）。利用者が保存した既定値があればそちらを使う
const DEFAULTS = {
    prepare: 10,  // 準備
    work: 20,     // 運動
    rest: 5,      // 休憩
    sets: 3,      // 回数（セット数）
};

// 各設定項目の入力範囲
const LIMITS = {
    prepare: { min: 0, max: 599, unit: '秒' },
    work:    { min: 1, max: 599, unit: '秒' },
    rest:    { min: 0, max: 599, unit: '秒' },
    sets:    { min: 1, max: 99,  unit: '回' },
};

// フェーズ
const PHASE = {
    IDLE: '待機',
    PREPARE: '準備',
    WORK: '運動',
    REST: '休憩',
    DONE: '完了',
};

// フェーズごとの見た目
const PHASE_STYLE = {
    [PHASE.IDLE]:    { bg: 'bg-slate-900',   accent: '#94a3b8', text: '開始待ち' },
    [PHASE.PREPARE]: { bg: 'bg-blue-800',    accent: '#93c5fd', text: '準備' },
    [PHASE.WORK]:    { bg: 'bg-red-800',     accent: '#fca5a5', text: '運動' },
    [PHASE.REST]:    { bg: 'bg-emerald-800', accent: '#6ee7b7', text: '休憩' },
    [PHASE.DONE]:    { bg: 'bg-purple-800',  accent: '#d8b4fe', text: '完了' },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// --- 既定値の保存 -----------------------------------------------------------
const DEFAULTS_KEY = 'logtimer-defaults';

// 保存された既定値を読む（無ければ組み込みの既定値）
const loadDefaults = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || 'null');
        if (!saved) return DEFAULTS;
        const pick = (key) => {
            const n = parseInt(saved[key], 10);
            return Number.isNaN(n) ? DEFAULTS[key] : clamp(n, LIMITS[key].min, LIMITS[key].max);
        };
        return { prepare: pick('prepare'), work: pick('work'), rest: pick('rest'), sets: pick('sets') };
    } catch (e) {
        // 壊れたデータや localStorage が使えない環境では組み込みの既定値に戻す
        return DEFAULTS;
    }
};

const saveDefaults = (s) => {
    try {
        localStorage.setItem(DEFAULTS_KEY, JSON.stringify(s));
    } catch (e) {
        // 保存できなくてもタイマー自体は動く
    }
};

// 起動時の設定
const INITIAL = loadDefaults();

// 秒数を表示用文字列にする（60秒以上は m:ss 形式）
const formatTime = (seconds) => {
    if (seconds < 60) return String(seconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
};

// --- 実行履歴 ---------------------------------------------------------------
const HISTORY_KEY = 'logtimer-history';
const HISTORY_MAX = 50; // 保存する件数の上限（古いものから捨てる）

const loadHistory = () => {
    try {
        const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch (e) {
        // 壊れたデータや localStorage が使えない環境では履歴なしとして扱う
        return [];
    }
};

const saveHistory = (list) => {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
        // 保存できなくてもタイマー自体は動く
    }
};

// 履歴の日時表示（yyyy/mm/dd hh:mm）
const formatStamp = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};

// 表示方法の切り替え用アイコン（下向き=カウントダウン / 上向き=カウントアップ）
const ArrowIcon = ({ up }) => (
    <svg
        width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
        {up
            ? <path d="M12 20V4M5 11l7-7 7 7" />
            : <path d="M12 4v16M5 13l7 7 7-7" />}
    </svg>
);

// 日ごとの実施回数を開くアイコン
const CalendarIcon = () => (
    <svg
        width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
);

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 履歴を「年-月-日」ごとの件数にまとめる
const countByDay = (history) => {
    const counts = {};
    history.forEach((h) => {
        const d = new Date(h.at);
        if (Number.isNaN(d.getTime())) return;
        const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
};

// 月カレンダーのマス目（先頭は曜日合わせの空きマス）
const monthCells = (year, month) => {
    const cells = [];
    for (let i = 0; i < new Date(year, month, 1).getDay(); i++) cells.push(null);
    const last = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= last; d++) cells.push(d);
    return cells;
};

// 設定値の増減フィールド（4項目を横に並べるため縦積みの1枠にまとめる）
const NumberField = ({ label, value, onChange, limit, disabled }) => {
    const step = (delta) => onChange(clamp(value + delta, limit.min, limit.max));
    const btn = 'h-8 rounded-lg bg-white/10 text-white text-lg leading-none disabled:opacity-30 active:bg-white/20';

    return (
        <div className="min-w-0 flex flex-col gap-1">
            <div className="text-sm text-white/80 text-center truncate">
                {label}<span className="text-white/40">({limit.unit})</span>
            </div>
            <input
                type="number"
                inputMode="numeric"
                value={value}
                disabled={disabled}
                onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    onChange(Number.isNaN(n) ? limit.min : clamp(n, limit.min, limit.max));
                }}
                className="w-full h-9 rounded-lg bg-white/10 text-white text-center tabular disabled:opacity-40"
                aria-label={label}
            />
            <div className="grid grid-cols-2 gap-1">
                <button
                    type="button"
                    onClick={() => step(-1)}
                    disabled={disabled || value <= limit.min}
                    className={btn}
                    aria-label={label + 'を減らす'}
                >−</button>
                <button
                    type="button"
                    onClick={() => step(1)}
                    disabled={disabled || value >= limit.max}
                    className={btn}
                    aria-label={label + 'を増やす'}
                >＋</button>
            </div>
        </div>
    );
};

const App = () => {
    const [settings, setSettings] = useState(INITIAL);
    const [defaults, setDefaults] = useState(INITIAL); // 「既定値に戻す」で戻る先
    const [countUp, setCountUp] = useState(false); // false: カウントダウン / true: カウントアップ
    const [muted, setMuted] = useState(false);
    const [installEvent, setInstallEvent] = useState(null);
    const [history, setHistory] = useState(loadHistory); // 完了した実行の記録（新しい順）
    const [showCalendar, setShowCalendar] = useState(false); // 履歴一覧と日別カレンダーの切り替え
    const [calMonth, setCalMonth] = useState(() => {
        const d = new Date();
        return { y: d.getFullYear(), m: d.getMonth() };
    });

    const [phase, setPhase] = useState(PHASE.IDLE);
    const [currentSet, setCurrentSet] = useState(1);
    const [remaining, setRemaining] = useState(INITIAL.prepare > 0 ? INITIAL.prepare : INITIAL.work); // 現フェーズの残り秒（小数を含む）
    const [isRunning, setIsRunning] = useState(false);

    const deadlineRef = useRef(0);      // 現フェーズの終了時刻（epoch ms）
    const audioCtxRef = useRef(null);
    const lastBeepRef = useRef(null);   // 秒読みビープの二重再生防止
    const wakeLockRef = useRef(null);

    // --- 音 -----------------------------------------------------------------
    const beep = useCallback((frequency, duration = 0.12) => {
        if (muted) return;
        try {
            if (!audioCtxRef.current) {
                audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
            }
            const ctx = audioCtxRef.current;
            if (ctx.state === 'suspended') ctx.resume();

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(frequency, ctx.currentTime);
            // 末尾のプチッというノイズを避けるため減衰させる
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + duration);
        } catch (e) {
            // 音が出せない環境でもタイマー自体は動かす
        }
    }, [muted]);

    // --- 画面スリープ防止 ----------------------------------------------------
    const requestWakeLock = useCallback(async () => {
        if (!('wakeLock' in navigator) || wakeLockRef.current) return;
        try {
            wakeLockRef.current = await navigator.wakeLock.request('screen');
            wakeLockRef.current.addEventListener('release', () => { wakeLockRef.current = null; });
        } catch (e) {
            // 取得できなくても動作に支障はない
        }
    }, []);

    const releaseWakeLock = useCallback(() => {
        if (wakeLockRef.current) {
            wakeLockRef.current.release().catch(() => {});
            wakeLockRef.current = null;
        }
    }, []);

    // --- ホーム画面への追加 --------------------------------------------------
    // Android Chrome などは追加可能になった時点でイベントを投げてくる
    useEffect(() => {
        const onPrompt = (e) => {
            e.preventDefault();
            setInstallEvent(e);
        };
        const onInstalled = () => setInstallEvent(null);
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const install = useCallback(async () => {
        if (!installEvent) return;
        installEvent.prompt();
        await installEvent.userChoice;
        setInstallEvent(null);
    }, [installEvent]);

    // --- 履歴の記録 ----------------------------------------------------------
    const addHistory = useCallback((s) => {
        setHistory((prev) => {
            const next = [{
                id: Date.now(),
                at: new Date().toISOString(),
                prepare: s.prepare,
                work: s.work,
                rest: s.rest,
                sets: s.sets,
            }, ...prev].slice(0, HISTORY_MAX);
            saveHistory(next);
            return next;
        });
    }, []);

    const clearHistory = useCallback(() => {
        setHistory([]);
        saveHistory([]);
    }, []);

    // --- 既定値の操作 --------------------------------------------------------
    // いまの設定を既定値として保存する（次回起動時もこの値で立ち上がる）
    const saveAsDefaults = useCallback(() => {
        setDefaults(settings);
        saveDefaults(settings);
    }, [settings]);

    const restoreDefaults = useCallback(() => setSettings(defaults), [defaults]);

    // 既定値と同じ設定なら「戻す」「設定」のどちらも押す必要がない
    const isDefaultSettings = defaults.prepare === settings.prepare
        && defaults.work === settings.work
        && defaults.rest === settings.rest
        && defaults.sets === settings.sets;

    // --- フェーズ進行 --------------------------------------------------------
    const durationOf = useCallback((p) => {
        if (p === PHASE.PREPARE) return settings.prepare;
        if (p === PHASE.WORK) return settings.work;
        if (p === PHASE.REST) return settings.rest;
        return 0;
    }, [settings]);

    // 次のフェーズ
    const nextOf = useCallback((p, s) => {
        if (p === PHASE.PREPARE) return { phase: PHASE.WORK, set: s };
        if (p === PHASE.WORK) return s < settings.sets ? { phase: PHASE.REST, set: s } : { phase: PHASE.DONE, set: s };
        if (p === PHASE.REST) return { phase: PHASE.WORK, set: s + 1 };
        return { phase: PHASE.DONE, set: s };
    }, [settings]);

    const advance = useCallback(() => {
        // 0秒に設定されたフェーズは読み飛ばす
        let next = nextOf(phase, currentSet);
        while (next.phase !== PHASE.DONE && durationOf(next.phase) <= 0) {
            next = nextOf(next.phase, next.set);
        }

        lastBeepRef.current = null;

        if (next.phase === PHASE.DONE) {
            beep(1046, 0.35);
            setTimeout(() => beep(1318, 0.5), 200);
            setPhase(PHASE.DONE);
            setIsRunning(false);
            setRemaining(0);
            addHistory(settings); // 最後まで終えた実行だけ履歴に残す
            releaseWakeLock();
            return;
        }

        beep(next.phase === PHASE.WORK ? 880 : 660, 0.25);
        const d = durationOf(next.phase);
        deadlineRef.current = Date.now() + d * 1000;
        setPhase(next.phase);
        setCurrentSet(next.set);
        setRemaining(d);
    }, [phase, currentSet, nextOf, durationOf, beep, releaseWakeLock, addHistory, settings]);

    // --- 計時（実時刻ベースなので取りこぼしても遅れない） ----------------------
    useEffect(() => {
        if (!isRunning) return;

        const tick = () => {
            const rest = (deadlineRef.current - Date.now()) / 1000;
            if (rest <= 0) {
                advance();
                return;
            }
            setRemaining(rest);
            // 残り3秒からの秒読み
            const sec = Math.ceil(rest);
            if (sec <= 3 && lastBeepRef.current !== sec) {
                lastBeepRef.current = sec;
                beep(784, 0.1);
            }
        };

        const id = setInterval(tick, 100);
        return () => clearInterval(id);
    }, [isRunning, advance, beep]);

    // 待機中は設定変更を残り時間に反映する
    useEffect(() => {
        if (phase === PHASE.IDLE) {
            setRemaining(settings.prepare > 0 ? settings.prepare : settings.work);
        }
    }, [phase, settings]);

    // 画面復帰時にスリープ防止を取り直す
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible' && isRunning) requestWakeLock();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [isRunning, requestWakeLock]);

    // --- 操作 ---------------------------------------------------------------
    // 指定した設定で最初から開始する（履歴からの再実行でも使う）
    const startWith = useCallback((s) => {
        // 最初のフェーズを決める（準備が0秒なら運動から）
        const first = s.prepare > 0 ? PHASE.PREPARE : PHASE.WORK;
        const d = first === PHASE.PREPARE ? s.prepare : s.work;
        deadlineRef.current = Date.now() + d * 1000;
        lastBeepRef.current = null;
        setPhase(first);
        setCurrentSet(1);
        setRemaining(d);
        beep(first === PHASE.WORK ? 880 : 660, 0.25);
        setIsRunning(true);
        requestWakeLock();
    }, [beep, requestWakeLock]);

    const start = useCallback(() => {
        if (phase === PHASE.IDLE || phase === PHASE.DONE) {
            startWith(settings);
            return;
        }
        // 一時停止からの再開
        deadlineRef.current = Date.now() + remaining * 1000;
        setIsRunning(true);
        requestWakeLock();
    }, [phase, settings, remaining, startWith, requestWakeLock]);

    // 履歴の行をタップしたとき: その設定を読み込んで即実行する
    const runAgain = useCallback((entry) => {
        if (isRunning) return;
        const s = {
            prepare: clamp(entry.prepare, LIMITS.prepare.min, LIMITS.prepare.max),
            work:    clamp(entry.work,    LIMITS.work.min,    LIMITS.work.max),
            rest:    clamp(entry.rest,    LIMITS.rest.min,    LIMITS.rest.max),
            sets:    clamp(entry.sets,    LIMITS.sets.min,    LIMITS.sets.max),
        };
        setSettings(s);
        startWith(s);
    }, [isRunning, startWith]);

    const pause = useCallback(() => {
        setRemaining(Math.max(0, (deadlineRef.current - Date.now()) / 1000));
        setIsRunning(false);
        releaseWakeLock();
    }, [releaseWakeLock]);

    const reset = useCallback(() => {
        setIsRunning(false);
        setPhase(PHASE.IDLE);
        setCurrentSet(1);
        setRemaining(settings.prepare > 0 ? settings.prepare : settings.work);
        lastBeepRef.current = null;
        releaseWakeLock();
    }, [settings, releaseWakeLock]);

    const toggle = useCallback(() => (isRunning ? pause() : start()), [isRunning, pause, start]);

    // キーボード操作（Space: 開始/一時停止、R: リセット）
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.target.tagName === 'INPUT') return;
            if (e.code === 'Space') {
                e.preventDefault();
                toggle();
            } else if (e.key === 'r' || e.key === 'R') {
                reset();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [toggle, reset]);

    // --- 表示用の値 ----------------------------------------------------------
    const style = PHASE_STYLE[phase];
    const phaseDuration = phase === PHASE.IDLE
        ? (settings.prepare > 0 ? settings.prepare : settings.work)
        : durationOf(phase);
    const elapsed = Math.max(0, phaseDuration - remaining);
    const shownSeconds = phase === PHASE.DONE
        ? 0
        : (countUp ? Math.floor(elapsed) : Math.ceil(remaining));
    // 進捗リング: カウントダウンは減り、カウントアップは増える
    const progress = phaseDuration > 0
        ? clamp(countUp ? elapsed / phaseDuration : remaining / phaseDuration, 0, 1)
        : 0;

    const totalSeconds = settings.prepare + settings.sets * settings.work + (settings.sets - 1) * settings.rest;
    const RADIUS = 130;
    const CIRC = 2 * Math.PI * RADIUS;
    // 円の表示サイズ（元は 300px、約70%に縮小）。狭い画面ではさらに縮める
    const DIAL_SIZE = 'min(210px, 56vw)';

    // カレンダー表示用: 日ごとの実施回数と、その月のマス目
    const dayCounts = countByDay(history);
    const cells = monthCells(calMonth.y, calMonth.m);
    const monthTotal = cells.reduce(
        (sum, d) => sum + (d === null ? 0 : (dayCounts[calMonth.y + '-' + calMonth.m + '-' + d] || 0)),
        0,
    );
    const today = new Date();
    const shiftMonth = (delta) => setCalMonth((c) => {
        const d = new Date(c.y, c.m + delta, 1);
        return { y: d.getFullYear(), m: d.getMonth() };
    });

    return (
        <div
            className={'h-[100dvh] flex flex-col overflow-hidden transition-colors duration-500 text-white ' + style.bg}
            style={{
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
                paddingLeft: 'env(safe-area-inset-left)',
                paddingRight: 'env(safe-area-inset-right)',
            }}
        >
            <div className="w-full max-w-md mx-auto px-4 py-3 flex-1 min-h-0 flex flex-col gap-3">

                <header className="shrink-0 flex items-center justify-between gap-2">
                    <h1 className="text-lg font-bold tracking-wide">logTimer</h1>
                    <div className="flex items-center gap-2">
                        {installEvent && (
                            <button
                                type="button"
                                onClick={install}
                                className="text-xs text-white px-2.5 py-1 rounded-lg bg-white/20"
                            >ホーム画面に追加</button>
                        )}
                        <button
                            type="button"
                            onClick={() => setMuted((m) => !m)}
                            className="text-xs text-white/70 px-2 py-1 rounded-lg bg-white/10"
                            aria-label="音のオン・オフ"
                        >{muted ? '音 オフ' : '音 オン'}</button>
                    </div>
                </header>

                {/* 左: タイマー本体 / 右: 操作ボタン */}
                <div className="shrink-0 flex items-center gap-3">
                    <div className="relative shrink-0" style={{ width: DIAL_SIZE, height: DIAL_SIZE }}>
                        <svg viewBox="0 0 300 300" className="-rotate-90 w-full h-full">
                            <circle cx="150" cy="150" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="14" />
                            <circle
                                cx="150" cy="150" r={RADIUS} fill="none"
                                stroke={style.accent} strokeWidth="14" strokeLinecap="round"
                                strokeDasharray={CIRC}
                                strokeDashoffset={CIRC * (1 - progress)}
                                style={{ transition: 'stroke-dashoffset 120ms linear' }}
                            />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <div className="text-sm font-medium text-white/80">{style.text}</div>
                            <div className="text-5xl font-bold tabular leading-none my-1">{formatTime(shownSeconds)}</div>
                            <div className="text-xs text-white/70">
                                {phase === PHASE.DONE
                                    ? '全 ' + settings.sets + ' 回 終了'
                                    : currentSet + ' / ' + settings.sets + ' 回目'}
                            </div>
                        </div>
                    </div>

                    <div className="flex-1 min-w-0 flex flex-col gap-2">
                        <button
                            type="button"
                            onClick={toggle}
                            className="h-14 rounded-2xl bg-white text-slate-900 text-lg font-bold active:scale-95 transition-transform"
                        >
                            {isRunning ? '一時停止' : (phase === PHASE.IDLE || phase === PHASE.DONE ? 'スタート' : '再開')}
                        </button>
                        <button
                            type="button"
                            onClick={reset}
                            className="h-12 rounded-2xl bg-white/15 text-white text-base font-bold active:scale-95 transition-transform"
                        >
                            リセット
                        </button>

                        {/* 表示方法: ↓ カウントダウン / ↑ カウントアップ */}
                        <div className="grid grid-cols-2 gap-2">
                            {[
                                { key: false, label: 'カウントダウン（残り時間）' },
                                { key: true,  label: 'カウントアップ（経過時間）' },
                            ].map((opt) => (
                                <button
                                    key={String(opt.key)}
                                    type="button"
                                    onClick={() => setCountUp(opt.key)}
                                    title={opt.label}
                                    aria-label={opt.label}
                                    aria-pressed={countUp === opt.key}
                                    className={'h-11 rounded-xl border flex items-center justify-center transition-colors ' + (countUp === opt.key
                                        ? 'bg-white text-slate-900 border-white'
                                        : 'bg-white/5 text-white/80 border-white/20')}
                                >
                                    <ArrowIcon up={opt.key} />
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* 設定（カレンダー表示中は隠して、その分カレンダーを広く使う） */}
                {!showCalendar && (
                    <div className="shrink-0 rounded-2xl bg-black/20 px-3 py-3">
                        <div className="flex items-baseline justify-between mb-1">
                            <div className="text-sm text-white/80">設定</div>
                            <div className="text-xs text-white/60">
                                合計 {Math.floor(totalSeconds / 60)}分{String(totalSeconds % 60).padStart(2, '0')}秒
                            </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                            <NumberField label="準備" value={settings.prepare} limit={LIMITS.prepare} disabled={isRunning}
                                onChange={(v) => setSettings((s) => ({ ...s, prepare: v }))} />
                            <NumberField label="運動" value={settings.work} limit={LIMITS.work} disabled={isRunning}
                                onChange={(v) => setSettings((s) => ({ ...s, work: v }))} />
                            <NumberField label="休憩" value={settings.rest} limit={LIMITS.rest} disabled={isRunning}
                                onChange={(v) => setSettings((s) => ({ ...s, rest: v }))} />
                            <NumberField label="回数" value={settings.sets} limit={LIMITS.sets} disabled={isRunning}
                                onChange={(v) => setSettings((s) => ({ ...s, sets: v }))} />
                        </div>
                        <div className="mt-2 flex items-center gap-4 text-xs">
                            <button
                                type="button"
                                onClick={restoreDefaults}
                                disabled={isRunning || isDefaultSettings}
                                className="text-white/70 underline disabled:opacity-30"
                            >既定値に戻す（{defaults.prepare}/{defaults.work}/{defaults.rest}/{defaults.sets}回）</button>
                            <button
                                type="button"
                                onClick={saveAsDefaults}
                                disabled={isRunning || isDefaultSettings}
                                className="text-white/70 underline disabled:opacity-30"
                                title="いまの設定を既定値として保存します"
                            >既定値に設定</button>
                        </div>
                    </div>
                )}

                {/* 履歴（画面の下側。行をタップするとその設定で再実行） */}
                <div className="flex-1 min-h-0 flex flex-col rounded-2xl bg-black/20 px-3 py-2">
                    <div className="flex items-center justify-between px-1">
                        <div className="text-sm text-white/80">履歴</div>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setShowCalendar((v) => !v)}
                                aria-pressed={showCalendar}
                                aria-label="日ごとの実施回数"
                                title="日ごとの実施回数"
                                className={'w-7 h-7 rounded-lg flex items-center justify-center transition-colors ' + (showCalendar
                                    ? 'bg-white text-slate-900'
                                    : 'bg-white/10 text-white/70')}
                            ><CalendarIcon /></button>
                            {history.length > 0 && (
                                <button
                                    type="button"
                                    onClick={clearHistory}
                                    disabled={isRunning}
                                    className="text-xs text-white/60 underline disabled:opacity-30"
                                >全消去</button>
                            )}
                        </div>
                    </div>

                    {showCalendar ? (
                        /* 日ごとの実施回数（月カレンダー） */
                        <div className="flex-1 min-h-0 flex flex-col">
                            <div className="flex items-center justify-between px-1 py-1">
                                <button
                                    type="button"
                                    onClick={() => shiftMonth(-1)}
                                    className="w-7 h-7 rounded-lg bg-white/10 text-white/80 leading-none active:bg-white/20"
                                    aria-label="前の月"
                                >‹</button>
                                <div className="text-sm text-white/80">
                                    {calMonth.y}年{calMonth.m + 1}月
                                    <span className="ml-2 text-xs text-white/60">計 {monthTotal} 回</span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => shiftMonth(1)}
                                    className="w-7 h-7 rounded-lg bg-white/10 text-white/80 leading-none active:bg-white/20"
                                    aria-label="次の月"
                                >›</button>
                            </div>
                            <div className="grid grid-cols-7 gap-1 pb-1 text-center text-xs">
                                {WEEKDAYS.map((w, i) => (
                                    <div key={w} className={i === 0 ? 'text-red-300' : (i === 6 ? 'text-blue-300' : 'text-white/50')}>{w}</div>
                                ))}
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
                                <div className="grid grid-cols-7 gap-1 text-center">
                                    {cells.map((d, i) => {
                                        if (d === null) return <div key={'empty' + i} />;
                                        const n = dayCounts[calMonth.y + '-' + calMonth.m + '-' + d] || 0;
                                        const isToday = today.getFullYear() === calMonth.y
                                            && today.getMonth() === calMonth.m
                                            && today.getDate() === d;
                                        return (
                                            <div
                                                key={d}
                                                className={'rounded-lg py-1 ' + (n > 0 ? 'bg-white/20' : 'bg-white/5')
                                                    + (isToday ? ' ring-1 ring-white/70' : '')}
                                            >
                                                <div className="text-xs text-white/60 leading-none">{d}</div>
                                                <div className="text-sm font-bold tabular leading-none mt-1 h-4">
                                                    {n > 0 ? n : ''}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    ) : (
                        /* 実行の一覧 */
                        <React.Fragment>
                            <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-sm text-white/80">
                                <span className="flex-1 min-w-0">日時</span>
                                <span className="w-8 text-right">準備</span>
                                <span className="w-8 text-right">運動</span>
                                <span className="w-8 text-right">休憩</span>
                                <span className="w-8 text-right">回数</span>
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain divide-y divide-white/10">
                                {history.length === 0 ? (
                                    <p className="text-xs text-white/40 text-center py-4">
                                        最後まで実行すると、ここに記録されます
                                    </p>
                                ) : history.map((h) => (
                                    <button
                                        key={h.id}
                                        type="button"
                                        onClick={() => runAgain(h)}
                                        disabled={isRunning}
                                        title="タップするとこの設定で実行します"
                                        className="w-full flex items-center gap-1.5 px-2 py-2 text-sm text-left active:bg-white/10 disabled:opacity-40"
                                    >
                                        <span className="flex-1 min-w-0 truncate text-xs text-white/70">{formatStamp(h.at)}</span>
                                        <span className="w-8 text-right tabular">{h.prepare}</span>
                                        <span className="w-8 text-right tabular">{h.work}</span>
                                        <span className="w-8 text-right tabular">{h.rest}</span>
                                        <span className="w-8 text-right tabular">{h.sets}</span>
                                    </button>
                                ))}
                            </div>
                        </React.Fragment>
                    )}
                </div>

                <p className="shrink-0 hidden sm:block text-xs text-white/50 text-center">
                    スペースキー: 開始 / 一時停止　・　R キー: リセット
                </p>
            </div>
        </div>
    );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
