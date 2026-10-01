// Tailwind CSS の設定。styles.css の作り方は README の「スタイル（Tailwind CSS）のビルド」を参照
// クラス名は index.html と app.js の文字列から拾う。クラス名を文字列の連結や ${} で組み立てると拾えないので、
// 'bg-red-800' のように完全な形で書くこと
module.exports = {
    content: ['./index.html', './app.js'],
    theme: { extend: {} },
    plugins: [],
};
