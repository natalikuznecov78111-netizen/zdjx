const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const TIMEOUT = 8000;

// ---------- 工具 ----------
function httpGet(url, headers = {}, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, ...headers }
    })
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

async function getText(url, headers = {}) {
  const r = await httpGet(url, headers);
  return await r.text();
}

async function getJson(url, headers = {}) {
  const r = await httpGet(url, headers);
  return await r.json();
}

function baseResult(platform, type) {
  return { platform, type, title: '', desc: '', author: '', cover: '',
    publishTime: null, stats: {}, media: { playable: false, embedUrl: '', webUrl: '', appUrl: '' },
    images: [], raw: '' };
}

// 提取BV号
function extractBvid(url) {
  const m = url.match(/(BV[0-9A-Za-z]{10})/);
  if (m) return m[1];
  const av = url.match(/av(\d+)/);
  return av ? 'av' + av[1] : null;
}

// OG 标签兜底
async function ogFallback(url, result) {
  try {
    const html = await getText(url);
    const $ = cheerio.load(html);
    result.title = $('meta[property="og:title"]').attr('content')
      || $('title').text() || result.title || '';
    result.desc = $('meta[property="og:description"]').attr('content')
      || $('meta[name="description"]').attr('content') || result.desc || '';
    result.cover = $('meta[property="og:image"]').attr('content') || result.cover || '';
    if (!result.title && !result.desc) {
      // readability 简化版：直接抓 body 文本前3000字
      const text = $('body').text().replace(/\s+/g, ' ').trim();
      result.raw = text.slice(0, 3000);
    }
  } catch (e) { /* 静默失败 */ }
  return result;
}

// ---------- 各平台解析器 ----------

async function parseBilibili(url) {
  const r = baseResult('bilibili', 'video');
  r.media.webUrl = url;
  const bvid = extractBvid(url);
  if (!bvid) return ogFallback(url, r);
  try {
    const api = bvid.startsWith('av')
      ? `https://api.bilibili.com/x/web-interface/view?${bvid}`
      : `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const j = await getJson(api, { Referer: 'https://www.bilibili.com' });
    if (j.code === 0 && j.data) {
      const d = j.data;
      r.title = d.title; r.desc = d.desc; r.author = d.owner?.name || '';
      r.cover = d.pic; r.publishTime = d.pubdate ? d.pubdate * 1000 : null;
      r.stats = { plays: d.stat?.view, likes: d.stat?.like, comments: d.stat?.danmaku };
      r.media.playable = true;
      r.media.embedUrl = `https://player.bilibili.com/player.html?bvid=${d.bvid}&autoplay=0`;
      r.media.appUrl = `bilibili://video/${d.bvid}`;
    } else { return ogFallback(url, r); }
  } catch (e) { return ogFallback(url, r); }
  return r;
}

async function parseWeibo(url) {
  const r = baseResult('weibo', 'post');
  r.media.webUrl = url;
  const idMatch = url.match(/(\d+)\/(\w+)$/) || url.match(/status\/(\d+)/) ||
    url.match(/weibo\.cn\/s\/(\w+)/);
  try {
    // 提取微博id：数字id
    const numId = url.match(/\/(\d{10,})/) ? url.match(/\/(\d{10,})/)[1] : null;
    if (numId) {
      const j = await getJson(`https://m.weibo.cn/statuses/show?id=${numId}`);
      if (j && j.data) {
        const d = j.data;
        r.title = (d.text || '').replace(/<[^>]+>/g, '').slice(0, 80) || '微博动态';
        r.desc = (d.text || '').replace(/<[^>]+>/g, '').slice(0, 500);
        r.raw = (d.text || '').replace(/<[^>]+>/g, '');
        r.author = d.user?.screen_name || '';
        r.cover = d.user?.avatar_hd || '';
        r.publishTime = d.created_at ? Date.parse(d.created_at) : null;
        r.stats = { comments: d.comments_count, likes: d.attitudes_count };
        if (d.pics) r.images = d.pics.map(p => p.large?.url || p.url).filter(Boolean);
        const pageInfo = d.page_info;
        if (pageInfo?.type === 'video') {
          r.media.playable = false;
          r.media.appUrl = pageInfo.urls?.[Object.keys(pageInfo.urls)[0]] || url;
        }
        return r;
      }
    }
  } catch (e) { /* fallthrough */ }
  return ogFallback(url, r);
}

async function parseTwitter(url) {
  const r = baseResult('twitter', 'post');
  r.media.webUrl = url;
  const idMatch = url.match(/status\/(\d+)/);
  if (!idMatch) return ogFallback(url, r);
  try {
    const j = await getJson(`https://api.fxtwitter.com/status/${idMatch[1]}`);
    const t = j?.tweet;
    if (t) {
      r.title = `${t.author?.name || ''} (@${t.author?.screen_name || ''})`;
      r.desc = t.text || '';
      r.raw = t.text || '';
      r.author = t.author?.name || '';
      r.cover = t.media?.photos?.[0]?.url || t.author?.avatar_url || '';
      r.publishTime = t.created_at ? Date.parse(t.created_at) : null;
      r.stats = { likes: t.likes, comments: t.replies };
      if (t.media?.photos) r.images = t.media.photos.map(p => p.url);
      if (t.media?.videos?.length) {
        r.media.playable = true;
        r.media.embedUrl = t.media.videos[0].url;
      }
      return r;
    }
  } catch (e) { /* fallthrough */ }
  return ogFallback(url, r);
}

async function parseWechat(url) {
  const r = baseResult('wechat', 'article');
  r.media.webUrl = url;
  try {
    const html = await getText(url);
    const $ = cheerio.load(html);
    r.title = $('meta[property="og:title"]').attr('content')
      || $('#activity-name').text().trim() || '公众号文章';
    r.desc = $('meta[property="og:description"]').attr('content') || '';
    r.cover = $('meta[property="og:image"]').attr('content') || '';
    r.author = $('meta[name="author"]').attr('content')
      || $('#js_name').text().trim() || '';
    const content = $('#js_content').text().replace(/\s+/g, ' ').trim();
    r.raw = content.slice(0, 3000) || r.desc;
    r.publishTime = Date.parse($('meta[property="article:published_time"]').attr('content') || '') || null;
  } catch (e) { /* fallthrough */ }
  return r;
}

async function parseZhihu(url) {
  const r = baseResult('zhihu', 'article');
  r.media.webUrl = url;
  try {
    // 问题
    const qMatch = url.match(/question\/(\d+)/);
    const aMatch = url.match(/answer\/(\d+)/);
    if (qMatch) {
      const j = await getJson(`https://www.zhihu.com/api/v4/questions/${qMatch[1]}?include=detail`);
      r.title = j.title || '';
      r.desc = (j.detail || '').replace(/<[^>]+>/g, '').slice(0, 500);
      r.raw = (j.detail || '').replace(/<[^>]+>/g, '').slice(0, 3000);
      r.stats = { comments: j.answer_count };
      return r;
    }
    if (aMatch) {
      const j = await getJson(`https://www.zhihu.com/api/v4/answers/${aMatch[1]}?include=content`);
      r.title = j.question?.title || '知乎回答';
      r.raw = (j.content || '').replace(/<[^>]+>/g, '').slice(0, 3000);
      r.desc = r.raw.slice(0, 500);
      r.author = j.author?.name || '';
      r.stats = { likes: j.voteup_count, comments: j.comment_count };
      return r;
    }
  } catch (e) { /* fallthrough */ }
  return ogFallback(url, r);
}

async function parseYoutube(url) {
  const r = baseResult('youtube', 'video');
  r.media.webUrl = url;
  const vMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  if (!vMatch) return ogFallback(url, r);
  const vid = vMatch[1];
  try {
    // 2秒快速超时，国内无梯子能快速降级（服务器在海外一般能通）
    const j = await getJson(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${vid}`, {}, 2000);
    if (j && j.title) {
      r.title = j.title; r.author = j.author_name || '';
      r.cover = j.thumbnail_url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
      r.media.playable = true;
      r.media.embedUrl = `https://www.youtube-nocookie.com/embed/${vid}`;
      return r;
    }
  } catch (e) { /* fallthrough */ }
  r.cover = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  r.title = 'YouTube 视频';
  return ogFallback(url, r);
}

async function parseDouyin(url) {
  const r = baseResult('douyin', 'video');
  r.media.webUrl = url;
  try {
    // 先跟随短链拿真实URL
    const real = await httpGet(url);
    const realUrl = real.url;
    r.media.webUrl = realUrl;
    const idMatch = realUrl.match(/video\/(\d+)/) || url.match(/video\/(\d+)/);
    if (idMatch) {
      try {
        const j = await getJson(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${idMatch[1]}`);
        const item = j?.item_list?.[0];
        if (item) {
          r.title = item.desc || '抖音视频';
          r.desc = item.desc || '';
          r.raw = item.desc || '';
          r.author = item.author?.nickname || '';
          r.cover = item.video?.cover?.url_list?.[0] || '';
          r.stats = { plays: item.statistics?.play_count, likes: item.statistics?.digg_count, comments: item.statistics?.comment_count };
          r.publishTime = item.create_time ? item.create_time * 1000 : null;
          r.media.playable = false;
          r.media.appUrl = `snssdk1128://aweme/detail/${idMatch[1]}`;
          return r;
        }
      } catch (e) { /* fallthrough */ }
    }
  } catch (e) { /* fallthrough */ }
  return ogFallback(url, r);
}

async function parseKuaishou(url) {
  const r = baseResult('kuaishou', 'video');
  r.media.webUrl = url;
  try {
    const html = await getText(url);
    const $ = cheerio.load(html);
    r.title = $('meta[property="og:title"]').attr('content') || '快手视频';
    r.desc = $('meta[property="og:description"]').attr('content') || '';
    r.cover = $('meta[property="og:image"]').attr('content') || '';
    r.author = $('meta[name="author"]').attr('content') || '';
    // 尝试从 pageData 抠更多信息
    const pageDataMatch = html.match(/window\.pageData\s*=\s*({.*?});/s);
    if (pageDataMatch) {
      try {
        const pd = JSON.parse(pageDataMatch[1]);
        const video = pd?.video;
        if (video) {
          r.title = video.caption || r.title;
          r.author = video.userName || r.author;
          r.cover = video.coverUrls?.[0]?.url || r.cover;
          r.stats = { plays: video.viewCount, likes: video.likeCount, comments: video.commentCount };
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { return ogFallback(url, r); }
  return r;
}

async function parseXhs(url) {
  const r = baseResult('xhs', 'note');
  r.media.webUrl = url;
  try {
    const html = await getText(url);
    const $ = cheerio.load(html);
    r.title = $('meta[property="og:title"]').attr('content') || '小红书笔记';
    r.desc = $('meta[property="og:description"]').attr('content') || '';
    r.cover = $('meta[property="og:image"]').attr('content') || '';
    // 尝试提取初始JSON里的图片列表
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?)<\/script>/s);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1].replace(/undefined/g, 'null'));
        const note = data?.note?.noteDetailMap;
        const firstKey = note ? Object.keys(note)[0] : null;
        if (firstKey && note[firstKey]?.note) {
          const n = note[firstKey].note;
          r.title = n.title || r.title;
          r.desc = n.desc || r.desc;
          r.raw = (n.desc || '').slice(0, 3000);
          r.images = (n.imageList || []).map(i => i.urlDefault || i.url).filter(Boolean);
          r.author = n.user?.nickname || '';
          r.stats = { likes: n.interactInfo?.likedCount };
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { return ogFallback(url, r); }
  return r;
}

async function parseGeneric(url) {
  const r = baseResult('web', 'link');
  r.media.webUrl = url;
  return ogFallback(url, r);
}

// ---------- 平台识别 ----------

function recognize(url) {
  const u = url.toLowerCase();
  if (u.includes('bilibili.com') || u.includes('b23.tv')) return 'bilibili';
  if (u.includes('weibo.com') || u.includes('weibo.cn') || u.includes('t.cn')) return 'weibo';
  if (u.includes('twitter.com') || u.includes('x.com') || u.includes('t.co')) return 'twitter';
  if (u.includes('mp.weixin.qq.com')) return 'wechat';
  if (u.includes('zhihu.com')) return 'zhihu';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('douyin.com') || u.includes('v.douyin.com') || u.includes('iesdouyin.com')) return 'douyin';
  if (u.includes('kuaishou.com') || u.includes('v.kuaishou.com')) return 'kuaishou';
  if (u.includes('xiaohongshu.com') || u.includes('xhslink.com')) return 'xhs';
  return 'web';
}

const PARSERS = {
  bilibili: parseBilibili, weibo: parseWeibo, twitter: parseTwitter,
  wechat: parseWechat, zhihu: parseZhihu, youtube: parseYoutube,
  douyin: parseDouyin, kuaishou: parseKuaishou, xhs: parseXhs,
  web: parseGeneric
};

// ---------- 路由 ----------

app.post('/parse', async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: '无效链接' });
  }
  const platform = recognize(url);
  try {
    const result = await PARSERS[platform](url);
    res.json(result);
  } catch (e) {
    // 绝不抛500，永远给兜底
    try {
      const fb = await parseGeneric(url);
      return res.json(fb);
    } catch (e2) {
      return res.json({ platform: 'web', type: 'link', title: url, media: { webUrl: url, playable: false, embedUrl: '', appUrl: '' } });
    }
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'link-parser' }));

app.listen(PORT, () => console.log(`✅ link-parser started on port ${PORT}`));
