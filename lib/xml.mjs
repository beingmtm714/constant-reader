// A small RSS/Atom reader. Every feed in sources.json is one of the two, and the
// fields wanted here are shallow, so a dependency would be the heavier option.

import { stripHtml } from './text.mjs';

function decodeCdata(s) {
  const m = String(s).match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? decodeCdata(m[1]).trim() : '';
}

function tagAll(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...block.matchAll(re)].map((m) => decodeCdata(m[1]).trim());
}

function attr(block, name, key) {
  const re = new RegExp(`<${name}[^>]*\\b${key}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function blocks(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseFeed(xml, baseUrl) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);

  for (const b of blocks(xml, isAtom ? 'entry' : 'item')) {
    let link = '';
    if (isAtom) {
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
      link = alt ? alt[1] : attr(b, 'link', 'href');
    } else {
      link = tag(b, 'link') || attr(b, 'link', 'href') || tag(b, 'guid');
    }

    const rawSummary = tag(b, 'description') || tag(b, 'summary') || tag(b, 'media:description');
    const rawContent = tag(b, 'content:encoded') || tag(b, 'content');

    items.push({
      title: stripHtml(tag(b, 'title')),
      link: absolute(stripHtml(link), baseUrl),
      guid: tag(b, 'guid') || tag(b, 'id') || link,
      author: stripHtml(tag(b, 'dc:creator') || tag(b, 'author') || tag(b, 'name')),
      date: parseDate(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
      summaryHtml: rawSummary,
      summary: deboilerplate(stripHtml(rawSummary)),
      content: stripHtml(rawContent),
      contentHtml: rawContent,
      categories: [...tagAll(b, 'category').map(stripHtml), ...(b.match(/<category[^>]*term=["']([^"']+)["']/gi) || []).map((s) => (s.match(/term=["']([^"']+)["']/i) || [])[1])].filter(Boolean),
    });
  }
  return items;
}

function absolute(link, baseUrl) {
  if (!link || !baseUrl || /^https?:\/\//i.test(link)) return link;
  try { return new URL(link, baseUrl).toString(); } catch { return link; }
}

// Every WordPress feed appends its own footer to the excerpt. It is not the review.
function deboilerplate(text) {
  return String(text || '')
    .replace(/\s*The post .*? appeared first on .*?\.?\s*$/i, '')
    .replace(/\s*Continue reading\.\.\.\s*$/i, '')
    .replace(/\s*Read more\s*$/i, '')
    .trim();
}
