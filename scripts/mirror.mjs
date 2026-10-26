// WordPress（iwonderful.okinawa）が表示しているページを、見た目ごとそのまま静的ファイルに保存する。
// Diver以外のテーマなので、中身だけ取り出すのではなく、表示されたHTML・CSS・JS・画像を丸ごと写す。
// 使い方:  node scripts/mirror.mjs        （途中で止まっても再実行すれば続きから。保存済みのファイルは取り直さない）
//          node scripts/mirror.mjs --fresh  （HTMLを取り直す。画像などは保存済みを使う）
import fs from "node:fs/promises";
import path from "node:path";

// ===== サイトごとの設定 =====
const HOST = "iwonderful.okinawa";
// 検索: "local" = サイト内で検索（/search/ と search-index.json を作る）、"google" = Google のサイト内検索へ
const SEARCH = "google";
// 消したい部分（HTMLの正規表現）。例: kokopelli の facebook ウィジェット /<aside id="text-6" class="widget widget_text">[\s\S]*?<\/aside>/g
const REMOVE = [
	// Google アナリティクス（Site Kit が入れるタグ。このサイトでは使わない）
	/<!--[^>]*Site Kit[^>]*-->\s*/g,
	/<script\b[^>]*id=["']google_gtagjs-js[^"']*["'][^>]*>[\s\S]*?<\/script>\s*/g,
	/<script\b[^>]*src=["']https:\/\/www\.googletagmanager\.com\/[^"']*["'][^>]*><\/script>\s*/g,
	// Google AdSense の広告（ウィジェットごと・記事中の広告・読み込み用のタグ）
	/<div id="custom_html-\d+" class="widget_text widget[^"]*"><div class="textwidget custom-html-widget">(?:(?!<\/div>)[\s\S])*?adsbygoogle(?:(?!<\/div>)[\s\S])*?<\/div><\/div>\s*/g,
	/<script\b[^>]*src=["'][^"']*pagead2\.googlesyndication\.com[^"']*["'][^>]*><\/script>\s*/g,
	/<!--[^>]*広告[^>]*-->\s*/g,
	/<ins class="adsbygoogle"[\s\S]*?<\/ins>\s*/g,
	/<script>\s*\(adsbygoogle = window\.adsbygoogle \|\| \[\]\)\.push\(\{\}\);\s*<\/script>\s*/g,
	/<meta name="google-adsense-[^>]*>\s*/g,
	/<link rel='dns-prefetch' href='\/\/pagead2\.googlesyndication\.com' \/>/g,
	// コメントのフィード・返信用スクリプト（静的サイトではコメントを受け付けない）
	/<link rel="alternate"[^>]*(?:コメントフィード|comments\/feed)[^>]*>\s*/g,
	/<script[^>]*comment-reply(?:\.min)?\.js[^>]*><\/script>\s*/g,
];
// 記事の日付を WordPress の本当の公開日に直す（refuse の Morning テーマ用。このサイトでは不要）
const FIX_DATES = false;
// ===========================

// サイト内検索のプログラムは scripts/search.js、言い換えは synonyms.txt（どちらも site/ にコピー・変換される）
const BASE = `https://${HOST}`;
const OUT = "site";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const FRESH = process.argv.includes("--fresh");
const HOST_RE = new RegExp(`(?:https?:)?(?:\\\\?/){2}${HOST.replace(/\./g, "\\.")}`, "g"); // https://… と https:\/\/… の両方
// 自サイトの絶対URLを「/…」に（URLがホスト名だけのときは「/」）
const HOST_ONLY_RE = new RegExp(HOST_RE.source + `(?=["'\\s<)])`, "g");
const localize = (s) => s.replace(HOST_ONLY_RE, "/").replace(HOST_RE, "");

const ASSET_EXT = /\.(css|js|mjs|json|png|jpe?g|gif|webp|avif|svg|ico|bmp|pdf|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|m4a|wav|zip|txt|xml|xsl)$/i;
const SKIP_PAGE = /^\/(wp-admin|wp-login\.php|xmlrpc\.php|wp-json|wp-cron\.php|feed|comments\/feed|trackback)(\/|$)|\/feed\/?$|\/trackback\/?$|\/embed\/?$|\.php$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, asText = true) {
	for (let i = 0; i < 4; i++) {
		try {
			const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
			if (r.status === 404 || r.status === 410) return { status: r.status, url: r.url, body: asText ? await r.text() : null };
			if (!r.ok) throw new Error(String(r.status));
			return { status: r.status, url: r.url, type: r.headers.get("content-type") || "", body: asText ? await r.text() : Buffer.from(await r.arrayBuffer()) };
		} catch (e) {
			if (i === 3) return { status: 0, url, error: e.message };
			await sleep(1500 * (i + 1));
		}
	}
}

// 自サイトのURLなら「/パス」を返す（それ以外は null）
function internal(raw, base) {
	if (!raw) return null;
	raw = raw.trim().replace(/&amp;/g, "&").replace(/&#0?38;/g, "&");
	if (/^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) return null;
	let u;
	try {
		u = new URL(raw, base);
	} catch {
		return null;
	}
	if (u.hostname !== HOST && u.hostname !== "www." + HOST) return null;
	return { path: u.pathname, search: u.search };
}

// 保存先（日本語のパスはデコードした名前で保存。Cloudflare はデコードしたパスで探す）
function filePath(p, isPage) {
	let d;
	try {
		d = decodeURIComponent(p);
	} catch {
		d = p;
	}
	if (isPage) return path.join(OUT, d.endsWith("/") ? d + "index.html" : d + "/index.html");
	return path.join(OUT, d);
}
const exists = (f) => fs.access(f).then(() => true, () => false);
async function save(f, data) {
	await fs.mkdir(path.dirname(f), { recursive: true });
	await fs.writeFile(f, data);
}

const pages = new Set(), pageQueue = [];
const postDates = new Map(); // 記事ID → 公開日（REST の date）
const catLinks = new Map(); // カテゴリーID → URL（カテゴリーの選択肢を静的サイトでも動かすため）
const assets = new Set(), assetQueue = [];
const redirects = new Map();
const failed = [];
const external = new Set();

function addPage(p) {
	if (!p || p.search || SKIP_PAGE.test(p.path) || ASSET_EXT.test(p.path)) return;
	if (!pages.has(p.path)) {
		pages.add(p.path);
		pageQueue.push(p.path);
	}
}
function addAsset(p) {
	if (!p || p.path === "/" || !(ASSET_EXT.test(p.path) || /^\/wp-(content|includes)\//.test(p.path))) return;
	if (/\.php$/.test(p.path)) return;
	if (!assets.has(p.path)) {
		assets.add(p.path);
		assetQueue.push(p.path);
	}
}

function scanHtml(html, base) {
	// リンク（ページか、ファイルへのリンク）
	for (const m of html.matchAll(/<(?:a|area)\b[^>]*\shref=["']([^"']+)["']/gi)) {
		const p = internal(m[1], base);
		if (!p) {
			if (/^https?:/.test(m[1])) external.add(m[1].replace(/&amp;/g, "&"));
			continue;
		}
		ASSET_EXT.test(p.path) ? addAsset(p) : addPage(p);
	}
	// 月別アーカイブの選択肢など
	for (const m of html.matchAll(/<option\b[^>]*\svalue=["']([^"']+)["']/gi)) if (/^(\/|https?:)/.test(m[1])) addPage(internal(m[1], base)); // カテゴリーの選択肢の値（数字のID）はURLではない
	// CSS・JS・画像
	for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = m[0];
		if (!/rel=["'][^"']*(stylesheet|icon|preload|apple-touch-icon)/i.test(tag)) continue;
		const h = tag.match(/\shref=["']([^"']+)["']/i);
		if (h) addAsset(internal(h[1], base));
	}
	for (const m of html.matchAll(/\s(?:src|data-src|data-lazy-src|poster|data-bg|data-background|data-thumbnail|data-large_image|data-src-img)=["']([^"']+)["']/gi)) addAsset(internal(m[1], base));
	for (const m of html.matchAll(/\s(?:srcset|data-srcset|data-lazy-srcset)=["']([^"']+)["']/gi)) {
		for (const part of m[1].split(",")) addAsset(internal(part.trim().split(/\s+/)[0], base));
	}
	for (const m of html.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image|msapplication-TileImage)["'][^>]*content=["']([^"']+)["']/gi)) addAsset(internal(m[1], base));
	scanCssText(html, base);
	// JSON内のURL（Elementor の設定や背景スライドなど）
	for (const m of html.matchAll(new RegExp(`https?:\\\\\\/\\\\\\/${HOST.replace(/\./g, "\\.")}(\\\\\\/wp-(?:content|includes)\\\\\\/[^"'\\s]+?\\.(?:png|jpe?g|gif|webp|svg|css|js|mp4|woff2?))`, "gi"))) {
		addAsset({ path: m[1].replace(/\\\//g, "/"), search: "" });
	}
}
// 一覧ページの記事ブロック（検索結果の表示に使う。WordPressの検索結果と同じ見た目）
const blocks = new Map();
function collectBlocks(html) {
	if (SEARCH !== "local") return;
	for (const m of html.matchAll(/<div class="post-(\d+) post type-post[^"]*">\s*<article>[\s\S]*?<\/article>\s*<\/div>/g)) {
		if (/<h1\b/.test(m[0]) || blocks.has(m[1])) continue;
		let b = fixDates(m[0]);
		for (const re of REMOVE) b = b.replace(re, "");
		for (const [x, y] of REPLACE) b = b.split(x).join(y);
		blocks.set(m[1], localize(b));
	}
}
function scanCssText(css, base) {
	for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) addAsset(internal(m[2], base));
	for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/gi)) addAsset(internal(m[1], base));
}

// 記事ごとの日付表示を本当の公開日に（<div class="post-ID …"> から次の記事までの最初の post-date）
function fixDates(html) {
	if (!FIX_DATES || postDates.size === 0) return html;
	const parts = html.split(/(?=<div class="post-\d+ )/);
	return parts
		.map((part) => {
			const id = part.match(/^<div class="post-(\d+) /)?.[1];
			const d = id && postDates.get(id);
			if (!d) return part;
			const [y, m, day] = d.slice(0, 10).split("-").map(Number);
			return part.replace(/(<span class="post-date">\s*)(?:Published\s*)?[^<]*?(\s*<\/span>)/, `$1Published ${y}年${m}月${day}日$2`);
		})
		.join("");
}

// wpX の高速化（mod_pagespeed）が付けた画像名「〜.jpg.pagespeed.ce.XXXX.jpg」を元の名前に戻す（その名前のファイルは今は取れないため）
const unPagespeed = (h) => h.replace(/(\.(?:jpe?g|png|gif|webp|svg|css|js))\.pagespeed\.[a-z]{2}\.[\w-]+\.(?:jpe?g|png|gif|webp|svg|css|js)/gi, "$1");
// 静的サイト用にHTMLを書き換える
// 英語の表示を日本語に（[英語, 日本語]）
const REPLACE = [
	// www 付きのリンクは www なしに（www.iwonderful.okinawa は iwonderful.okinawa へ転送する）
	["//www.iwonderful.okinawa", "//iwonderful.okinawa"],
];
function rewriteHtml(html) {
	// カテゴリーの選択肢（WordPress は ?cat=ID で探すが、静的サイトでは使えない）→ 値をカテゴリーのURLにして、選んだら移動
	html = html.replace(/(<select\b[^>]*\bid=['"]cat['"][^>]*>)([\s\S]*?)(<\/select>)/g, (m, a, opts, c) => a + opts.replace(/value="(\d+)"/g, (mm, id) => (catLinks.get(id) ? `value="${catLinks.get(id)}"` : mm)) + c);
	html = html.replace(/if \( dropdown\.value && parseInt\( dropdown\.value \) > 0 && dropdown instanceof HTMLSelectElement \) \{\s*dropdown\.parentElement\.submit\(\);/g, 'if ( dropdown.value && dropdown.value !== "-1" ) {\n\t\t\t\tdocument.location.href = dropdown.value;');
	for (const re of REMOVE) html = html.replace(re, "");
	for (const [a, b] of REPLACE) html = html.split(a).join(b);
	html = fixDates(html);
	return (
		html
			// WordPress の管理・API 用のリンク（静的サイトでは使えない）
			.replace(/<link\b[^>]*rel=["'](?:EditURI|pingback|wlwmanifest|https:\/\/api\.w\.org\/|shortlink)["'][^>]*>\s*/gi, "")
			.replace(/<link\b[^>]*type=["'](?:application|text)\/(?:json|xml)\+oembed["'][^>]*>\s*/gi, "")
			.replace(/<link\b[^>]*href=["'][^"']*\/wp-json\/[^"']*["'][^>]*>\s*/gi, "")
			// 「最新入居状況」の NEW! 印（WordPressの新着表示プラグイン。静的サイトでは古い記事にも出続けるので消す）
			.replace(/<span class=['"]newmark['"]>NEW!<\/span>/g, "")
			// 検索フォーム: サイト内検索（/search/）か、Google のサイト内検索へ
			.replace(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi, (m, attrs, inner) => {
				if (!/name=["']s["']/.test(inner)) return m;
				const a = attrs.replace(/\saction=["'][^"']*["']/i, "").replace(/\smethod=["'][^"']*["']/i, "");
				if (SEARCH === "local") return `<form${a} action="/search/" method="get">${inner}</form>`;
				const i = inner.replace(/name=["']s["']/, 'name="q"');
				return `<form${a} action="https://www.google.com/search" method="get" target="_blank"><input type="hidden" name="as_sitesearch" value="${HOST}">${i}</form>`;
			})
			// WordPress時代の検索URL（/?s=…）で来た人を /search/ へ
			.replace(/<head([^>]*)>/i, (m) => (SEARCH === "local" ? `${m}<script>if(/[?&]s=/.test(location.search)&&location.pathname!=="/search/")location.replace("/search/"+location.search)</script>` : m))
			// 自サイトの絶対URLを「/…」に（https:// と JSON内の https:\/\/ の両方）
	).replace(HOST_ONLY_RE, "/").replace(HOST_RE, "");
}

async function doPage(p) {
	const f = filePath(p, true);
	let html;
	if (!FRESH && (await exists(f))) {
		html = await fs.readFile(f, "utf8");
		scanHtml(html, BASE + p);
		collectBlocks(html);
		return;
	}
	const r = await get(BASE + p);
	if (r.status === 0 || !r.body) {
		failed.push(`${p} (${r.error || r.status})`);
		return;
	}
	if (r.status === 404) {
		failed.push(`${p} (404)`);
		return;
	}
	const final = new URL(r.url);
	if (final.hostname === HOST && final.pathname !== p) {
		// WordPress が別のURLへ転送した（末尾の / の付け足しなど）
		redirects.set(p, final.pathname + final.search);
		addPage({ path: final.pathname, search: final.search });
		return;
	}
	if (final.hostname !== HOST) {
		redirects.set(p, r.url);
		return;
	}
	if (!/html/.test(r.type)) {
		failed.push(`${p} (${r.type})`);
		return;
	}
	r.body = unPagespeed(r.body);
	scanHtml(r.body, BASE + p);
	collectBlocks(r.body);
	await save(f, rewriteHtml(r.body));
}

async function doAsset(p) {
	const f = filePath(p, false);
	const isCss = /\.css$/i.test(p);
	if (await exists(f)) {
		if (isCss) scanCssText(await fs.readFile(f, "utf8"), BASE + p);
		return;
	}
	const r = await get(BASE + encodeURI(decodeURI(p)), isCss || /\.(js|mjs|json|svg|xml|txt)$/i.test(p));
	if (r.status !== 200 || r.body == null) {
		failed.push(`${p} (${r.error || r.status})`);
		return;
	}
	let body = r.body;
	if (isCss) {
		scanCssText(body, BASE + p);
		body = localize(body);
	} else if (typeof body === "string") {
		body = localize(body);
	}
	await save(f, body);
}

let done = 0;
let busy = 0;

console.log("WordPressのページ一覧を取得しています…");
// REST（wpX は /wp-json/ を止めているので ?rest_route=）から記事・固定ページ・カテゴリーのURLを集める
// 切り替え後は WordPress に届かない（新しいサイトを写してしまう）ので止める
{
	const r = await get(`${BASE}/?rest_route=/`);
	let ok = false;
	try {
		ok = !!JSON.parse(r.body || "").namespaces;
	} catch {}
	if (!ok) {
		console.log("WordPress に接続できません。ドメインを切り替えた後は、このスクリプトは使えません（WordPress から取り直すには hosts で古いサーバーに向けてから実行）。");
		console.log("検索の言い換えを変えたときは npm run search を使ってください。");
		process.exit(1);
	}
}
const postsForSearch = [];
for (const [route, fields] of [["/wp/v2/posts", SEARCH === "local" ? "id,link,date,title,excerpt,content" : "id,link,date"], ["/wp/v2/pages", "id,link,date"], ["/wp/v2/categories", "id,link"], ["/wp/v2/tags", "link"]]) {
	for (let page = 1; ; page++) {
		const r = await get(`${BASE}/?rest_route=${route}&per_page=100&page=${page}&_fields=${fields}`);
		let list = [];
		try {
			list = JSON.parse(r.body || "[]");
		} catch {}
		if (!Array.isArray(list) || list.length === 0) break;
		for (const x of list) addPage(internal(x.link, BASE));
		if (route === "/wp/v2/categories") for (const x of list) if (x.id) catLinks.set(String(x.id), internal(x.link, BASE)?.path);
		for (const x of list) if (x.id && x.date && /posts|pages/.test(route)) postDates.set(String(x.id), x.date);
		if (route === "/wp/v2/posts" && SEARCH === "local") postsForSearch.push(...list);
		if (list.length < 100) break;
	}
}
addPage({ path: "/", search: "" });
// Elementor がページを開いたあとに読み込むファイル（HTMLには書かれていないので、ここで指定して取る）
const EL = "/wp-content/plugins/elementor/assets";
const EXTRA = [
	`${EL}/lib/dialog/dialog.min.js`,
	`${EL}/lib/share-link/share-link.min.js`,
	`${EL}/css/conditionals/dialog.min.css`,
	`${EL}/css/conditionals/lightbox.min.css`,
	`${EL}/css/conditionals/e-swiper.min.css`,
	...["lightbox-lightbox", "background-slideshow", "section-stretched-section", "background-video", "text-editor", "toggle",
		"accordion", "tabs", "counter", "progress", "alert", "video", "image-carousel", "text-path", "container",
		"nested-tabs", "nested-accordion", "social-icons", "share-link", "load-more", "contact-buttons", "floating-bars"]
		.map((n) => `${EL}/js/chunks/${n}.min.js`),
];

console.log(`最初に見つかったページ: ${pages.size}`);

// ページの合間にファイルも取る（同時6本）
await Promise.all(
	Array.from({ length: 6 }, async () => {
		for (;;) {
			const p = pageQueue.shift();
			if (p !== undefined) {
				busy++;
				await doPage(p).finally(() => busy--);
			} else {
				const a = assetQueue.shift();
				if (a !== undefined) {
					busy++;
					await doAsset(a).finally(() => busy--);
				} else if (busy === 0) {
					return;
				} else {
					await sleep(200);
					continue;
				}
			}
			done++;
			if (done % 20 === 0)
				process.stdout.write(`\rページ ${pages.size}（残り ${pageQueue.length}）／ ファイル ${assets.size}（残り ${assetQueue.length}）／ 失敗 ${failed.length}   `);
		}
	}),
);
process.stdout.write("\n");

// Elementor を使っているサイトだけ、後から読み込まれるファイルも取る
if ([...assets].some((a) => a.startsWith(EL + "/"))) {
	for (const a of EXTRA) addAsset({ path: a, search: "" });
	while (assetQueue.length) await doAsset(assetQueue.shift());
}

// 存在しないページ（404）の見た目もWordPressと同じに
const nf = await get(BASE + "/this-page-does-not-exist-404/");
if (nf.body) nf.body = unPagespeed(nf.body);
if (nf.body) {
	scanHtml(nf.body, BASE + "/");
	await save(path.join(OUT, "404.html"), rewriteHtml(nf.body));
}
// 404ページが使うファイルの取りこぼし
while (assetQueue.length) await doAsset(assetQueue.shift());

// サイト内検索（/search/?s=…）。WordPressの「検索結果なし」のページを型にして、ブラウザ側で結果を差し込む
if (SEARCH === "local") {
	const KEY = "zzqqnotfound0";
	const t = await get(`${BASE}/?s=${KEY}`);
	if (t.body) {
		scanHtml(t.body, BASE + "/");
		const html = rewriteHtml(t.body)
			.replace(/<\/body>/i, `<script src="/search.js" defer></script>\n</body>`);
		await save(path.join(OUT, "search", "index.html"), html);
	} else failed.push("/?s= (検索ページの型)");
	const text = (h) =>
		(h || "")
			.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
			.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
			.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
			.replace(/Continue reading/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	// 漢字の読み（かな）。「はっぽう」で「発泡」が見つかるように。kuromoji（形態素解析）を使う
	let reading = (s) => "";
	try {
		const kuromoji = (await import("kuromoji")).default;
		const dicPath = "node_modules/kuromoji/dict/";
		const tokenizer = await new Promise((ok, ng) => kuromoji.builder({ dicPath }).build((e, t) => (e ? ng(e) : ok(t))));
		reading = (s) => tokenizer.tokenize(s).map((t) => (t.reading && t.reading !== "*" ? t.reading : t.surface_form)).join(" ");
	} catch (e) {
		console.log("（読みの追加は省略: kuromoji が使えません。npm install を実行してください）", e.message);
	}
	const posts = postsForSearch.map((x) => {
		const u = internal(x.link, BASE)?.path ?? "/";
		const title = text(x.title?.rendered);
		const body = text(x.content?.rendered);
		const b = blocks.get(String(x.id)) ?? `<div class="post type-post entry"><article><div class="post-container"><div class="post-header"><h2 class="post-title"><a href="${u}">${x.title?.rendered ?? ""}</a></h2></div></div></article></div>`;
		return { u, t: title, ty: reading(title), x: body, y: reading(body), d: x.date, b };
	});
	// 言い換え（synonyms.txt。1行に1組、空白区切り。# から後はメモ）
	let synonyms = [];
	try {
		synonyms = (await fs.readFile("synonyms.txt", "utf8"))
			.split("\n")
			.map((l) => l.replace(/#.*/, "").trim().split(/[\s　,、]+/).filter(Boolean))
			.filter((g) => g.length >= 2);
	} catch {}
	const index = posts;
	await save(path.join(OUT, "search-index.json"), JSON.stringify({ p: posts, s: synonyms }));
	await save(path.join(OUT, "search.js"), (await fs.readFile("scripts/search.js", "utf8")).replace("__KEY__", KEY));
	console.log(`サイト内検索: 記事 ${index.length}本・読みあり ${index.filter((i) => i.y).length}本・言い換え ${synonyms.length}組`);
}

// 転送（WordPress時代のURL → 今のURL）
const lines = ["# WordPress時代のURL → 今のURL（scripts/mirror.mjs が作成）", "/feed/ / 301", "/feed / 301", "/comments/feed/ / 301"];
for (const [from, to] of redirects) if (from + "/" !== to) lines.push(`${encodeURI(decodeURI(from))} ${to} 301`);
await save(path.join(OUT, "_redirects"), lines.join("\n") + "\n");
await save(path.join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${BASE}/sitemap.xml\n`);

// サイトマップ
const missing = new Set(failed.map((f) => f.replace(/ \(.*$/, "")));
const urls = [...pages].filter((p) => !redirects.has(p) && !missing.has(p)).sort();
await save(
	path.join(OUT, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((p) => `<url><loc>${BASE}${p}</loc></url>`).join("\n")}\n</urlset>\n`,
);
await save("pages.txt", urls.join("\n") + "\n");
await save("external-links.txt", [...external].sort().join("\n") + "\n");
if (failed.length) await save("failed.txt", failed.join("\n") + "\n");
console.log(`完了: ページ ${urls.length}・ファイル ${assets.size}・転送 ${redirects.size}・失敗 ${failed.length}${failed.length ? "（failed.txt）" : ""}`);

