#!/usr/bin/env python3
"""Proof-of-concept: link WhatsApp "Incident Advice" posts to CCIL incidents.

Companion to docs/briefs/WHATSAPP_INCIDENT_LINKING.md. Deterministic, no LLM.

    python3 scripts/whatsapp-ccil-link-poc.py <_chat.txt> <ccil.json> \
        --group north|south [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all]

<ccil.json> is a JSON array of rows with at least: ccil, report_date,
incident_start, advised_time, nwr_time, title, location, area,
incident_type_label, minutes_delay (see the brief for the SQL).

Steps: parse the iOS export → drop system/media-only lines → group posts into
threads on their *bold* headline → score each thread against CCIL rows whose
composed start (06:00 log day) lies within -2h/+30h of the first post.
Prints one line per thread with the best candidate and the timing lag.
"""
import argparse, collections, datetime as dt, json, re, statistics as st

LINE = re.compile(r'^‎?\[(\d{2}/\d{2}/\d{4}), (\d{2}:\d{2}:\d{2})\] ([^:]+?): (.*)$')
HEAD = re.compile(r'\*{1,2}([^*\n]{2,120})\*{1,2}')
GENERIC = re.compile(r'^(incident (headline|update|alert)|holding message|post incident service recovery|update|correction)', re.I)
SYS = re.compile(r'^‎.*(added|left|removed|joined|changed|created|privacy|encrypted|Added You)')
HEADCODE = re.compile(r'\b[0-9][A-Z][0-9]{2}\b')
NWR = re.compile(r'normal working resumed|NWR|handed back|line(s)? reopened|service recovery', re.I)
RAG = {'🔴': 'red', '🟠': 'amber', '🟡': 'yellow', '🟢': 'green'}
STOP = set('the a an and of at on in to for with between jn junction station line lines up down fast slow main road via no not is are has have been from by this that ll dn'.split())
KW = {'tcf': 'track circuit', 'track circuit': 'track circuit', 'signalling': 'signal', 'signal': 'signal',
      'points': 'points', 'pts': 'points', 'ole': 'ole', 'overhead': 'ole', 'dewire': 'ole', 'wirement': 'ole',
      'flood': 'flood', 'trespass': 'trespass', 'fatality': 'fatal', 'person': 'person', 'fire': 'fire',
      'bridge': 'bridge', 'strike': 'strike', 'struck': 'strike', 'ill passenger': 'passenger illness',
      'collapsed': 'passenger illness', 'failed': 'failure', 'failure': 'failure', 'rough ride': 'rough ride',
      'level crossing': 'crossing', 'crossing': 'crossing', 'possession': 'possession', 'overrun': 'possession',
      'train describer': 'describer', 'landslip': 'landslip', 'tree': 'tree', 'cow': 'animal', 'animal': 'animal',
      'loss of power': 'traction', 'traction': 'traction', 'brake': 'brake', 'pantograph': 'ole'}
AREA = {'north': {'E - EM - Derby', 'E - EM - Leicester', 'E - EM - Lincoln', 'E - EM - Route Wide', None},
        'south': {'E - EM - Bedford', 'E - EM - Route Wide', 'SX - Sussex', None}}


def parse_export(path):
    msgs, cur = [], None
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\r\n')
            m = LINE.match(line)
            if m:
                if cur: msgs.append(cur)
                d, t, s, body = m.groups()
                cur = {'ts': dt.datetime.strptime(d + ' ' + t, '%d/%m/%Y %H:%M:%S'), 'sender': s, 'body': body}
            elif cur:
                cur['body'] += '\n' + line
    if cur: msgs.append(cur)
    return msgs


def norm(h): return re.sub(r'[^a-z0-9 ]', '', h.lower()).strip()


def build_threads(msgs):
    threads, active, last = [], {}, None
    for m in msgs:
        b = m['body']
        if SYS.match(b) or b.strip() in ('‎image omitted', '‎video omitted'): continue
        m['rag'] = next((v for k, v in RAG.items() if k in b[:6]), None)
        h = HEAD.search(b[:220]); head = h.group(1).strip() if h else None
        m['head'] = head
        t = None
        if head and not GENERIC.match(head):
            key = norm(head); t = active.get(key)
            if t and (m['ts'] - t['msgs'][-1]['ts']) > dt.timedelta(hours=36): t = None
            if not t:
                t = {'title': head, 'msgs': []}; threads.append(t); active[key] = t
        elif head:  # generic template header → most recent thread within 6h
            if last and (m['ts'] - last['msgs'][-1]['ts']) < dt.timedelta(hours=6): t = last
            else:
                t = {'title': '(untitled) ' + b.split('\n')[0][:60], 'msgs': []}; threads.append(t)
        else:       # free text → most recent thread within 2h, else dropped
            if last and (m['ts'] - last['msgs'][-1]['ts']) < dt.timedelta(hours=2): t = last
            else: continue
        t['msgs'].append(m); last = t
    return threads


def load_ccil(path):
    rows = json.load(open(path))
    for r in rows:
        hhmm = (r.get('incident_start') or r.get('advised_time') or '12:00:00')
        r['start'] = dt.datetime.fromisoformat(r['report_date'] + 'T' + hhmm)
        if hhmm < '06:00:00': r['start'] += dt.timedelta(days=1)   # 06:00–06:00 log day
        r['text'] = ' '.join(str(r.get(k) or '') for k in ('title', 'location', 'incident_type_label', 'equipment', 'fault_number'))
    return rows


def toks(s): return {t for t in re.findall(r'[a-z0-9]{3,}', s.lower()) if t not in STOP}
def kws(s): s = s.lower(); return {v for k, v in KW.items() if k in s}


def score(t, r, grp):
    first = t['msgs'][0]; body = ' '.join(m['body'] for m in t['msgs'][:3])
    lag_h = (first['ts'] - r['start']).total_seconds() / 3600
    if lag_h < -2 or lag_h > 30: return 0, {}
    s, why = 0.0, {'lag_min': round(lag_h * 60)}
    hc = set(HEADCODE.findall(t['title'] + ' ' + body)) & set(HEADCODE.findall(r['text']))
    if hc: s += 5; why['headcode'] = sorted(hc)
    ov = toks(t['title']) & toks(r['text'])
    if ov: s += min(3, len(ov)); why['tokens'] = sorted(ov)
    kk = kws(t['title'] + ' ' + body[:400]) & kws(r['text'])
    if kk: s += 1.5; why['kw'] = sorted(kk)
    s += 0.5 if r.get('area') in AREA[grp] else -1
    if 0 <= lag_h <= 6: s += 1
    return s, why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('chat'); ap.add_argument('ccil')
    ap.add_argument('--group', choices=['north', 'south'], required=True)
    ap.add_argument('--from', dest='frm'); ap.add_argument('--to', dest='to')
    ap.add_argument('--all', action='store_true', help='print single-message threads too')
    a = ap.parse_args()
    msgs = parse_export(a.chat); threads = build_threads(msgs); ccil = load_ccil(a.ccil)
    lo = dt.datetime.fromisoformat(a.frm) if a.frm else dt.datetime.min
    hi = dt.datetime.fromisoformat(a.to) if a.to else dt.datetime.max
    sel = [t for t in threads if lo <= t['msgs'][0]['ts'] < hi]
    tally, lags = collections.Counter(), []
    for t in sel:
        ranked = sorted(((score(t, r, a.group), r) for r in ccil), key=lambda x: -x[0][0])
        (s1, w1), r1 = ranked[0]; s2 = ranked[1][0][0] if len(ranked) > 1 else 0
        tag = 'CONF' if (s1 >= 4 and s1 - s2 >= 1.5) else 'AMB ' if s1 >= 2.5 else 'NONE'
        tally[tag.strip()] += 1
        if tag == 'CONF': lags.append(w1['lag_min'])
        closed = any(m['rag'] == 'green' or NWR.search(m['body']) for m in t['msgs'])
        if a.all or len(t['msgs']) >= 2 or tag != 'NONE':
            print(f"{tag} {s1:4.1f} n={len(t['msgs']):2} close={'Y' if closed else '-'} "
                  f"[{t['msgs'][0]['ts']:%d/%m %H:%M}] {t['title'][:50]:50} -> "
                  f"{r1.get('ccil') if s1 else '-':>8} {(r1.get('title') or '')[:40]:40} @{(r1.get('location') or '')[:20]:20} {w1 if s1 else ''}")
    print(f"\n{a.group}: threads={len(sel)} {dict(tally)}")
    if lags: print(f"confident lag first post vs CCIL start: median={st.median(lags):.0f} min (n={len(lags)})")


if __name__ == '__main__':
    main()
