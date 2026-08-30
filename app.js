const { useState, useEffect, useRef, useCallback } = React;

// 既定値（秒 / 回）
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

// 秒数を表示用文字列にする（60秒以上は m:ss 形式）
const formatTime = (seconds) => {
    if (seconds < 60) return String(seconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
};

// 設定値の増減フィールド
const NumberField = ({ label, value, onChange, limit, disabled }) => {
    const step = (delta) => onChange(clamp(value + delta, limit.min, limit.max));

    return (
        <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-white/80">{label}</span>
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={() => step(-1)}
                    disabled={disabled || value <= limit.min}
                    className="w-9 h-9 rounded-lg bg-white/10 text-white text-lg leading-none disabled:opacity-30 active:bg-white/20"
                    aria-label={label + 'を減らす'}
                >−</button>
                <input
                    type="number"
                    inputMode="numeric"
                    value={value}
                    disabled={disabled}
                    onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        onChange(Number.isNaN(n) ? limit.min : clamp(n, limit.min, limit.max));
                    }}
                    className="w-16 h-9 rounded-lg bg-white/10 text-white text-center tabular disabled:opacity-40"
                    aria-label={label}
                />
                <button
                    type="button"
                    onClick={() => step(1)}
                    disabled={disabled || value >= limit.max}
                    className="w-9 h-9 rounded-lg bg-white/10 text-white text-lg leading-none disabled:opacity-30 active:bg-white/20"
                    aria-label={label + 'を増やす'}
                >＋</button>
                <span className="w-6 text-sm text-white/60">{limit.unit}</span>
            </div>
        </div>
    );
};

const App = () => {
    const [settings, setSettings] = useState(DEFAULTS);
    const [countUp, setCountUp] = useState(false); // false: カウントダウン / true: カウントアップ
    const [muted, setMuted] = useState(false);
    const [installEvent, setInstallEvent] = useState(null);

    const [phase, setPhase] = useState(PHASE.IDLE);
    const [currentSet, setCurrentSet] = useState(1);
    const [remaining, setRemaining] = useState(DEFAULTS.prepare); // 現フェーズの残り秒（小数を含む）
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
            releaseWakeLock();
            return;
        }

        beep(next.phase === PHASE.WORK ? 880 : 660, 0.25);
        const d = durationOf(next.phase);
        deadlineRef.current = Date.now() + d * 1000;
        setPhase(next.phase);
        setCurrentSet(next.set);
        setRemaining(d);
    }, [phase, currentSet, nextOf, durationOf, beep, releaseWakeLock]);

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
    const start = useCallback(() => {
        if (phase === PHASE.IDLE || phase === PHASE.DONE) {
            // 最初のフェーズを決める（準備が0秒なら運動から）
            const first = settings.prepare > 0 ? PHASE.PREPARE : PHASE.WORK;
            const d = durationOf(first);
            deadlineRef.current = Date.now() + d * 1000;
            lastBeepRef.current = null;
            setPhase(first);
            setCurrentSet(1);
            setRemaining(d);
            beep(first === PHASE.WORK ? 880 : 660, 0.25);
        } else {
            // 一時停止からの再開
            deadlineRef.current = Date.now() + remaining * 1000;
        }
        setIsRunning(true);
        requestWakeLock();
    }, [phase, settings, durationOf, remaining, beep, requestWakeLock]);

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

    return (
        <div
            className={'min-h-screen transition-colors duration-500 text-white ' + style.bg}
            style={{
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
                paddingLeft: 'env(safe-area-inset-left)',
                paddingRight: 'env(safe-area-inset-right)',
            }}
        >
            <div className="max-w-md mx-auto px-4 py-6 flex flex-col gap-5">

                <header className="flex items-center justify-between gap-2">
                    <h1 className="text-xl font-bold tracking-wide">logTimer</h1>
                    <div className="flex items-center gap-2">
                        {installEvent && (
                            <button
                                type="button"
                                onClick={install}
                                className="text-sm text-white px-3 py-1 rounded-lg bg-white/20"
                            >ホーム画面に追加</button>
                        )}
                        <button
                            type="button"
                            onClick={() => setMuted((m) => !m)}
                            className="text-sm text-white/70 px-2 py-1 rounded-lg bg-white/10"
                            aria-label="音のオン・オフ"
                        >{muted ? '音 オフ' : '音 オン'}</button>
                    </div>
                </header>

                {/* タイマー本体 */}
                <div className="relative flex items-center justify-center">
                    <svg width="300" height="300" viewBox="0 0 300 300" className="-rotate-90 max-w-full">
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
                        <div className="text-lg font-medium text-white/80">{style.text}</div>
                        <div className="text-7xl font-bold tabular leading-none my-1">{formatTime(shownSeconds)}</div>
                        <div className="text-sm text-white/70">
                            {phase === PHASE.DONE
                                ? '全 ' + settings.sets + ' 回 終了'
                                : currentSet + ' / ' + settings.sets + ' 回目'}
                        </div>
                    </div>
                </div>

                {/* 操作ボタン */}
                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={toggle}
                        className="flex-1 h-14 rounded-2xl bg-white text-slate-900 text-lg font-bold active:scale-95 transition-transform"
                    >
                        {isRunning ? '一時停止' : (phase === PHASE.IDLE || phase === PHASE.DONE ? 'スタート' : '再開')}
                    </button>
                    <button
                        type="button"
                        onClick={reset}
                        className="w-28 h-14 rounded-2xl bg-white/15 text-white text-lg font-bold active:scale-95 transition-transform"
                    >
                        リセット
                    </button>
                </div>

                {/* 表示方法 */}
                <div className="rounded-2xl bg-black/20 p-4">
                    <div className="text-sm text-white/80 mb-2">表示方法</div>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { key: false, label: 'カウントダウン', hint: '残り時間' },
                            { key: true,  label: 'カウントアップ', hint: '経過時間' },
                        ].map((opt) => (
                            <button
                                key={String(opt.key)}
                                type="button"
                                onClick={() => setCountUp(opt.key)}
                                className={'h-14 rounded-xl border transition-colors ' + (countUp === opt.key
                                    ? 'bg-white text-slate-900 border-white font-bold'
                                    : 'bg-white/5 text-white/80 border-white/20')}
                            >
                                <div className="text-sm">{opt.label}</div>
                                <div className="text-xs opacity-70">{opt.hint}</div>
                            </button>
                        ))}
                    </div>
                </div>

                {/* 設定 */}
                <div className="rounded-2xl bg-black/20 p-4">
                    <div className="flex items-baseline justify-between mb-1">
                        <div className="text-sm text-white/80">設定</div>
                        <div className="text-xs text-white/60">
                            合計 {Math.floor(totalSeconds / 60)}分{String(totalSeconds % 60).padStart(2, '0')}秒
                        </div>
                    </div>
                    <div className="divide-y divide-white/10">
                        <NumberField label="準備" value={settings.prepare} limit={LIMITS.prepare} disabled={isRunning}
                            onChange={(v) => setSettings((s) => ({ ...s, prepare: v }))} />
                        <NumberField label="運動" value={settings.work} limit={LIMITS.work} disabled={isRunning}
                            onChange={(v) => setSettings((s) => ({ ...s, work: v }))} />
                        <NumberField label="休憩" value={settings.rest} limit={LIMITS.rest} disabled={isRunning}
                            onChange={(v) => setSettings((s) => ({ ...s, rest: v }))} />
                        <NumberField label="回数" value={settings.sets} limit={LIMITS.sets} disabled={isRunning}
                            onChange={(v) => setSettings((s) => ({ ...s, sets: v }))} />
                    </div>
                    <button
                        type="button"
                        onClick={() => setSettings(DEFAULTS)}
                        disabled={isRunning}
                        className="mt-3 text-xs text-white/70 underline disabled:opacity-30"
                    >既定値に戻す（準備10秒 / 運動20秒 / 休憩5秒 / 3回）</button>
                </div>

                <p className="text-xs text-white/50 text-center">
                    スペースキー: 開始 / 一時停止　・　R キー: リセット
                </p>
            </div>
        </div>
    );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
