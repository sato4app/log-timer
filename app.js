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

// --- 音の鳴らし方 -----------------------------------------------------------
const SOUND_KEY = 'logtimer-sound';
const SOUND = { VOICE: 'voice', BEEP: 'beep', OFF: 'off' };
const SOUND_LABEL = { [SOUND.VOICE]: '音声', [SOUND.BEEP]: '電子音', [SOUND.OFF]: '音 オフ' };

// 読み上げに対応しているか（対応していれば端末内蔵の音声を使うので追加ファイルは不要）
const CAN_SPEAK = 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';

// ボタンを押すとこの順に切り替わる（読み上げ非対応の端末では「音声」を飛ばす）
const SOUND_ORDER = CAN_SPEAK
    ? [SOUND.VOICE, SOUND.BEEP, SOUND.OFF]
    : [SOUND.BEEP, SOUND.OFF];

const loadSoundMode = () => {
    try {
        const saved = localStorage.getItem(SOUND_KEY);
        return SOUND_ORDER.indexOf(saved) >= 0 ? saved : SOUND_ORDER[0];
    } catch (e) {
        // localStorage が使えない環境では既定の鳴らし方にする
        return SOUND_ORDER[0];
    }
};

const saveSoundMode = (mode) => {
    try {
        localStorage.setItem(SOUND_KEY, mode);
    } catch (e) {
        // 保存できなくてもタイマー自体は動く
    }
};

// 読み上げの速さ（1.0 が標準。少し速めにして秒読みに食い込まないようにする）
const SPEECH_RATE = 1.15;

// 読み上げに掛かる時間の見込み（ミリ秒）。
// 読み終わりは onend で拾うが、それが来ないブラウザでも秒読みが止まらないようにする保険
const estimateSpeechMs = (text) => 400 + text.length * 130;

// 秒読みの電子音。最後のひと鳴らし（カウントダウンの0）だけトーンを高く・長くして区切りが分かるようにする
const CUE_HZ = 784;
const LAST_CUE_HZ = 1175;
const LAST_CUE_SEC = 0.25;
const LAST_CUE_MS = 250; // 次のフェーズの合図はこれだけ遅らせて、最後のひと鳴らしと重ねない

// フェーズ切り替えの読み上げ文（運動だけは何回目かを添える）
const speechFor = (phase, set) => (phase === PHASE.WORK ? '運動 ' + set + ' 回目' : phase);

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

// --- 更新の確認 -------------------------------------------------------------
// 版数は service-worker.js の CACHE_NAME だけで決まる。
// 端末側の版は受け持ちの Service Worker に聞き、サーバー側の版は service-worker.js を読んで見比べる
const CACHE_PREFIX = 'logtimer-';

// 端末に残っているキャッシュの名前（版の削除と、Service Worker に聞けないときの控えに使う）
const localCacheNames = async () => {
    try {
        return (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
    } catch (e) {
        // キャッシュを覗けない環境では「分からない」＝空で返す
        return [];
    }
};

// 受け持ちの Service Worker に版を聞く（返事がなければ null）
const askWorkerCacheName = () => new Promise((resolve) => {
    try {
        const worker = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
        if (!worker) {
            resolve(null);
            return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => resolve(event.data || null);
        worker.postMessage('cache-name', [channel.port2]);
        setTimeout(() => resolve(null), 1500); // 返事が来ない版でも待たされないように
    } catch (e) {
        resolve(null);
    }
});

// 今この端末で動いている版。受け持ちがいなければ、入っているキャッシュの名前から拾う
const currentCacheName = async () => (await askWorkerCacheName()) || (await localCacheNames())[0] || null;

// サーバーにある版。Service Worker 側でキャッシュを挟まないようにしてあるので毎回ネットワークに聞ける
const fetchServerCacheName = async () => {
    const res = await fetch('service-worker.js', { cache: 'no-store' });
    if (!res.ok) return null;
    const found = (await res.text()).match(/CACHE_NAME\s*=\s*'([^']+)'/);
    return found ? found[1] : null;
};

// 新しい版に入れ替えて読み込み直す
const applyUpdate = async () => {
    try {
        const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
        if (reg) {
            await reg.update(); // 新しい service-worker.js を取り込む（install でキャッシュも作られる）
            if (reg.waiting) reg.waiting.postMessage('skip-waiting');
            // 新しい Service Worker が受け持ちを引き継ぐのを待つ（来なければ3秒で先へ進む）
            await new Promise((resolve) => {
                navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
                setTimeout(resolve, 3000);
            });
        } else {
            // Service Worker が使えない環境では、古いキャッシュを消してから読み込み直す
            const names = await localCacheNames();
            await Promise.all(names.map((n) => caches.delete(n)));
        }
    } catch (e) {
        // 入れ替えに失敗しても、読み込み直せば新しいファイルが取れることがある
    }
    window.location.reload();
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

// 履歴の一覧に戻るアイコン
const ListIcon = () => (
    <svg
        width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
        <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
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
    // 編集中の入力文字列。null は非編集（value をそのまま表示）
    const [draft, setDraft] = useState(null);
    const step = (delta) => onChange(clamp(value + delta, limit.min, limit.max));
    const btn = 'h-8 rounded-lg bg-white/10 text-white text-lg leading-none disabled:opacity-30 active:bg-white/20';

    // 編集を終えたときに確定する。空欄のままなら元の値に戻す
    const commit = () => {
        const n = parseInt(draft, 10);
        if (!Number.isNaN(n)) onChange(clamp(n, limit.min, limit.max));
        setDraft(null);
    };

    return (
        <div className="min-w-0 flex flex-col gap-1">
            <div className="text-sm text-white/80 text-center truncate">
                {label}<span className="text-white/40">({limit.unit})</span>
            </div>
            <input
                type="number"
                inputMode="numeric"
                value={draft === null ? value : draft}
                disabled={disabled}
                onFocus={() => setDraft('')}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                placeholder={String(value)}
                className="w-full h-9 rounded-lg bg-white/10 text-white text-center tabular placeholder:text-white/30 disabled:opacity-40"
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
    const [soundMode, setSoundMode] = useState(loadSoundMode); // 音声 / 電子音 / オフ
    const [installEvent, setInstallEvent] = useState(null);
    const [updateMessage, setUpdateMessage] = useState(null); // 更新確認の結果表示（null は非表示）
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
    const lastCueRef = useRef(null);    // 秒読みの二重再生防止
    const speechHoldRef = useRef(0);    // フェーズ名を言い終える時刻（epoch ms）。それまで秒読みを待たせる
    const speechIdRef = useRef(0);      // 読み上げの世代。古い onend で待ちを解除しないため
    const wakeLockRef = useRef(null);
    const localVersionRef = useRef(null); // 起動した時点で端末に入っていた版

    // --- 音 -----------------------------------------------------------------
    // 電子音（Web Audio API のサイン波）
    const beep = useCallback((frequency, duration = 0.12) => {
        try {
            if (!audioCtxRef.current) {
                audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
            }
            const ctx = audioCtxRef.current;

            const play = () => {
                const at = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(frequency, at);
                // 末尾のプチッというノイズを避けるため減衰させる
                gain.gain.setValueAtTime(0.4, at);
                gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
                osc.start(at);
                osc.stop(at + duration);
            };

            // 止まっているときは動き出してから鳴らす。
            // 止まったまま組み立てると、動き出した時にはもう鳴らす時刻を過ぎていて無音になる
            if (ctx.state === 'running') play();
            else ctx.resume().then(play).catch(() => {});
        } catch (e) {
            // 音が出せない環境でもタイマー自体は動かす
        }
    }, []);

    // 読み上げ（端末内蔵の音声を使うのでファイル追加なし・オフラインでも鳴る）
    // queue を立てると、前の読み上げを止めずに続けて読む（最後の数字とフェーズ名をつなげるため）
    const speak = useCallback((text, onEnd, queue) => {
        try {
            const synth = window.speechSynthesis;
            // 前の読み上げが残っていると次が遅れるので割り込む
            if (!queue && (synth.speaking || synth.pending)) synth.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'ja-JP';
            utterance.rate = SPEECH_RATE;
            if (onEnd) {
                utterance.onend = onEnd;
                utterance.onerror = onEnd;
            }
            synth.speak(utterance);
        } catch (e) {
            // 読み上げできない環境でもタイマー自体は動かす
        }
    }, []);

    const stopSpeaking = useCallback(() => {
        speechHoldRef.current = 0;
        try {
            if (CAN_SPEAK) window.speechSynthesis.cancel();
        } catch (e) {
            // 止められなくても支障はない
        }
    }, []);

    // 秒読みの鳴らし方。数字を読み上げるのは運動のときだけで、
    // 準備と休憩は「音声」設定でも電子音で知らせる（フェーズ名の読み上げはどのフェーズでも行う）
    const cueModeFor = useCallback((p) => (
        soundMode === SOUND.VOICE && p !== PHASE.WORK ? SOUND.BEEP : soundMode
    ), [soundMode]);

    // iOS は利用者の操作を起点にしないと音が出ないので、操作の中で音の出口を用意しておく
    const primeSound = useCallback((mode) => {
        if (mode === SOUND.OFF) return;
        try {
            // 電子音は「音声」でも使う（準備と休憩の秒読み）ので、どちらでも用意する
            if (!audioCtxRef.current) {
                audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
        } catch (e) {
            // 音が出せない環境でもタイマー自体は動かす
        }
        // 読み上げの下ごしらえは「音声」のときだけ。
        // 電子音のときに読み上げを通すと、iOS では音の受け持ちが読み上げ側に移って電子音が鳴らなくなる
        if (mode !== SOUND.VOICE) return;
        try {
            if (!CAN_SPEAK) return;
            const utterance = new SpeechSynthesisUtterance(' '); // 無音を1つ通しておく
            utterance.volume = 0;
            window.speechSynthesis.speak(utterance);
        } catch (e) {
            // 読み上げできない環境でもタイマー自体は動かす
        }
    }, []);

    // フェーズの切り替えを知らせる。読み上げの場合は言い終わるまで秒読みを待たせる。
    // after は直前に鳴らしたフェーズ最後の合図 { text, spoken }。渡すと、それが済んでから知らせる
    const announce = useCallback((text, frequency, duration, after) => {
        if (soundMode === SOUND.VOICE) {
            const id = ++speechIdRef.current;
            // 最後の数字を読み上げた直後なら、それを読み終えるまでの分も待たせる
            const wait = after && after.spoken ? estimateSpeechMs(after.text) : 0;
            speechHoldRef.current = Date.now() + estimateSpeechMs(text) + wait;
            // 見込みより早く言い終わったら、その時点で秒読みを解禁する
            speak(text, () => {
                if (speechIdRef.current === id) speechHoldRef.current = 0;
            }, Boolean(wait));
        } else if (soundMode === SOUND.BEEP) {
            // 最後のひと鳴らしと重ならないよう、少し置いてから鳴らす
            if (after) setTimeout(() => beep(frequency, duration), LAST_CUE_MS);
            else beep(frequency, duration);
        }
    }, [soundMode, speak, beep]);

    // 秒読みをひとつ鳴らす。フェーズ名を言い終えていなければ見送る（false を返す）
    const countdown = useCallback((p, sec, frequency, duration) => {
        const mode = cueModeFor(p);
        if (mode === SOUND.VOICE) {
            if (Date.now() < speechHoldRef.current) return false;
            speak(String(sec));
        } else if (mode === SOUND.BEEP) {
            beep(frequency, duration);
        }
        return true;
    }, [cueModeFor, speak, beep]);

    // 音声 → 電子音 → オフ の順に切り替える（選んだ方式は次回の起動時も引き継ぐ）
    const cycleSound = useCallback(() => {
        const next = SOUND_ORDER[(SOUND_ORDER.indexOf(soundMode) + 1) % SOUND_ORDER.length];
        if (next !== SOUND.VOICE) stopSpeaking(); // 読み上げ中なら止める
        primeSound(next);                         // 次の音を出せるようにしておく（iOS 対策）
        saveSoundMode(next);
        setSoundMode(next);
    }, [soundMode, stopSpeaking, primeSound]);

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

    // --- 更新の確認 ----------------------------------------------------------
    // 起動した時点の版を控えておく。
    // あとでブラウザが裏で Service Worker だけ入れ替えても、今動いている版が分かるようにするため
    useEffect(() => {
        currentCacheName().then((name) => {
            localVersionRef.current = name;
        });
    }, []);

    // タイトルをタップしたとき: サーバーの版と見比べて、違っていれば入れ替えて読み込み直す
    const checkUpdate = useCallback(async () => {
        if (updateMessage && updateMessage.endsWith('…')) return; // 確認中の二度押しは無視する
        // 読み込み直すと実行中の記録が消えるので、走らせている間は見送る
        if (isRunning) {
            setUpdateMessage('実行中は確認しません');
            return;
        }
        setUpdateMessage('確認中…');
        try {
            const server = await fetchServerCacheName();
            if (!server) {
                setUpdateMessage('確認できません');
                return;
            }
            const local = localVersionRef.current || await currentCacheName();
            // 端末にキャッシュが無い（毎回ネットワークから読んでいる）ときは、そのままで最新
            if (!local || local === server) {
                setUpdateMessage('最新です（' + server.replace(CACHE_PREFIX, '') + '）');
                return;
            }
            setUpdateMessage('更新中…');
            await applyUpdate(); // 読み込み直すので、ここから先は表示されない
        } catch (e) {
            // オフラインなどでサーバーに聞けないとき
            setUpdateMessage('確認できません');
        }
    }, [updateMessage, isRunning]);

    // 確認の結果は数秒で消す（「…」で終わる途中経過は残す）
    useEffect(() => {
        if (!updateMessage || updateMessage.endsWith('…')) return;
        const id = setTimeout(() => setUpdateMessage(null), 4000);
        return () => clearTimeout(id);
    }, [updateMessage]);

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

    // after: フェーズの終わりに読み上げた最後の数字（読み上げていなければ null）
    const advance = useCallback((after) => {
        // 0秒に設定されたフェーズは読み飛ばす
        let next = nextOf(phase, currentSet);
        while (next.phase !== PHASE.DONE && durationOf(next.phase) <= 0) {
            next = nextOf(next.phase, next.set);
        }

        lastCueRef.current = null;

        if (next.phase === PHASE.DONE) {
            announce('終了。お疲れさまでした', 1046, 0.35, after);
            // 電子音のときだけ2音目を重ねる（読み上げは文で終わりを伝えられる）
            if (soundMode === SOUND.BEEP) {
                setTimeout(() => beep(1318, 0.5), (after ? LAST_CUE_MS : 0) + 200);
            }
            setPhase(PHASE.DONE);
            setIsRunning(false);
            setRemaining(0);
            addHistory(settings); // 最後まで終えた実行だけ履歴に残す
            releaseWakeLock();
            return;
        }

        announce(speechFor(next.phase, next.set), next.phase === PHASE.WORK ? 880 : 660, 0.25, after);
        const d = durationOf(next.phase);
        deadlineRef.current = Date.now() + d * 1000;
        setPhase(next.phase);
        setCurrentSet(next.set);
        setRemaining(d);
    }, [phase, currentSet, nextOf, durationOf, announce, soundMode, beep, releaseWakeLock, addHistory, settings]);

    // --- 計時（実時刻ベースなので取りこぼしても遅れない） ----------------------
    useEffect(() => {
        if (!isRunning) return;

        // 運動は最初から最後まで毎秒読み上げる。数字は画面の数字に合わせる
        // （運動20秒なら、カウントダウン表示は 20・19…1・0、カウントアップ表示は 1・2…19・20）。
        // 準備と休憩は数字を読まないので、どちらの表示でも終了3秒前の電子音だけにする
        const readsNumbers = cueModeFor(phase) === SOUND.VOICE;
        const cueUp = readsNumbers && countUp;
        const duration = durationOf(phase);

        const tick = () => {
            const rest = (deadlineRef.current - Date.now()) / 1000;
            if (rest <= 0) {
                // フェーズ最後の合図（カウントダウンなら 0、カウントアップならフェーズの秒数）。
                // 音声は数字を読み上げ、電子音は秒読みと違うトーンで鳴らす。
                // 鳴らしたときは、次のフェーズの合図をそのぶん待たせる
                const last = cueUp ? duration : 0;
                const cued = countdown(phase, last, LAST_CUE_HZ, LAST_CUE_SEC);
                advance(cued ? { text: String(last), spoken: readsNumbers } : null);
                return;
            }
            setRemaining(rest);
            // 秒読み。
            // フェーズ名の読み上げ中は見送り、言い終わってからその時点の秒で再開する
            const sec = cueUp ? Math.floor(duration - rest) : Math.ceil(rest);
            // 読み上げるフェーズは全区間（カウントアップの 0 は読まない）。それ以外は残り3秒から
            const due = readsNumbers ? sec >= 1 : sec <= 3;
            if (due && lastCueRef.current !== sec && countdown(phase, sec, CUE_HZ, 0.1)) {
                lastCueRef.current = sec;
            }
        };

        const id = setInterval(tick, 100);
        return () => clearInterval(id);
    }, [isRunning, advance, countdown, countUp, cueModeFor, phase, durationOf]);

    // 秒読みの向きが変わったら、直前に鳴らした秒の記録は捨てる（切り替え直後の1回が飛ばないように）
    useEffect(() => {
        lastCueRef.current = null;
    }, [countUp, soundMode]);

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
        lastCueRef.current = null;
        setPhase(first);
        setCurrentSet(1);
        setRemaining(d);
        // iOS は利用者の操作を起点にしないと音が出ないので、この操作の中で用意しておく
        primeSound(soundMode);
        announce(speechFor(first, 1), first === PHASE.WORK ? 880 : 660, 0.25);
        setIsRunning(true);
        requestWakeLock();
    }, [announce, requestWakeLock, soundMode, primeSound]);

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
        stopSpeaking();
        releaseWakeLock();
    }, [stopSpeaking, releaseWakeLock]);

    const reset = useCallback(() => {
        setIsRunning(false);
        setPhase(PHASE.IDLE);
        setCurrentSet(1);
        setRemaining(settings.prepare > 0 ? settings.prepare : settings.work);
        lastCueRef.current = null;
        stopSpeaking();
        releaseWakeLock();
    }, [settings, stopSpeaking, releaseWakeLock]);

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
                    {/* タイトルは見た目そのままで、タップすると更新の確認をする */}
                    <div className="min-w-0 flex items-baseline gap-2">
                        <h1 className="text-lg font-bold tracking-wide shrink-0">
                            <button
                                type="button"
                                onClick={checkUpdate}
                                className="active:opacity-60"
                                aria-label="更新を確認する"
                                title="タップで更新を確認"
                            >logTimer</button>
                        </h1>
                        {updateMessage && (
                            <span className="text-xs text-white/60 truncate">{updateMessage}</span>
                        )}
                    </div>
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
                            onClick={cycleSound}
                            className="text-xs text-white/70 px-2 py-1 rounded-lg bg-white/10"
                            aria-label="音の鳴らし方の切り替え（音声 / 電子音 / オフ）"
                        >{SOUND_LABEL[soundMode]}</button>
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
                    <div className="flex items-center justify-between gap-2 px-1">
                        <div className="text-sm text-white/80">{showCalendar ? '日ごとの回数' : '履歴'}</div>
                        <div className="flex items-center gap-3">
                            {/* 一覧 / カレンダーの切り替え（押している方が白く反転する） */}
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => setShowCalendar(false)}
                                    aria-pressed={!showCalendar}
                                    aria-label="履歴の一覧"
                                    title="履歴の一覧"
                                    className={'w-7 h-7 rounded-lg flex items-center justify-center transition-colors ' + (showCalendar
                                        ? 'bg-white/10 text-white/70'
                                        : 'bg-white text-slate-900')}
                                ><ListIcon /></button>
                                <button
                                    type="button"
                                    onClick={() => setShowCalendar(true)}
                                    aria-pressed={showCalendar}
                                    aria-label="日ごとの実施回数"
                                    title="日ごとの実施回数"
                                    className={'w-7 h-7 rounded-lg flex items-center justify-center transition-colors ' + (showCalendar
                                        ? 'bg-white text-slate-900'
                                        : 'bg-white/10 text-white/70')}
                                ><CalendarIcon /></button>
                            </div>
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
