// Pulpit AI Łowca Leadów — co się dzieje w pozyskiwaniu leadów i ile to kosztuje.
// Wszystkie liczby liczone są z surowych danych (hand.stats), nie z liczników,
// więc nie da się ich rozjechać przez nieudany zapis.
import { useMemo, useState } from 'react'
import { session } from '../lib/api.js'
import { useHand } from '../lib/useHand.js'
import { LineChart, Bars, Donut, StatCard } from '../shared/Charts.jsx'
import {
  IcTarget,
  IcSend,
  IcChat,
  IcWallet,
  IcSpark,
  IcClock,
  IcPulse,
  IcSearch,
} from '../shared/Icons.jsx'
import { SkelPage } from '../shared/Skeleton.jsx'

const dayKey = (iso) => (iso ? String(iso).slice(0, 10) : '')
const fmtDay = (k) => `${k.slice(8, 10)}.${k.slice(5, 7)}`
const usd = (n) => (n >= 1 ? n.toFixed(2) : n.toFixed(3)) + ' $'
const SOURCE_LABEL = { linkedin: 'LinkedIn', maps: 'Google Maps', web: 'Web' }

export default function Dashboard() {
  const proj = session.proj
  const [days, setDays] = useState(30)
  const [data] = useHand('stats', { project_id: proj.id, days })

  const S = useMemo(() => {
    const leads = data?.leads ?? []
    const messages = data?.messages ?? []
    const usage = data?.usage ?? []
    const runs = data?.runs ?? []

    const keys = []
    for (let i = days - 1; i >= 0; i--) keys.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10))
    const zero = () => Object.fromEntries(keys.map((k) => [k, 0]))

    const leadsPerDay = zero()
    const bySource = {}
    const byStatus = {}
    let scoreSum = 0
    for (const l of leads) {
      const k = dayKey(l.created_at)
      if (k in leadsPerDay) leadsPerDay[k]++
      bySource[l.source] = (bySource[l.source] ?? 0) + 1
      byStatus[l.status] = (byStatus[l.status] ?? 0) + 1
      scoreSum += Number(l.score ?? 0)
    }

    const outPerDay = zero()
    const inPerDay = zero()
    let out = 0
    let inc = 0
    for (const m of messages) {
      const k = dayKey(m.created_at)
      if (m.direction === 'out') {
        out++
        if (k in outPerDay) outPerDay[k]++
      } else {
        inc++
        if (k in inPerDay) inPerDay[k]++
      }
    }

    const costPerDay = zero()
    let cost = 0
    const costByAction = {}
    for (const u of usage) {
      const c = Number(u.cost_usd ?? 0)
      cost += c
      costByAction[u.action] = (costByAction[u.action] ?? 0) + c
      const k = dayKey(u.created_at)
      if (k in costPerDay) costPerDay[k] += c
    }

    // czas do pierwszej odpowiedzi — mediana, bo średnią psuje jeden lead po tygodniu
    const gaps = leads
      .filter((l) => l.last_in_at && l.created_at)
      .map((l) => (new Date(l.last_in_at) - new Date(l.created_at)) / 3600_000)
      .filter((h) => h >= 0)
      .sort((a, b) => a - b)
    const medianH = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0

    const replied = byStatus.replied ?? 0
    const contacted = (byStatus.contacted ?? 0) + replied
    return {
      labels: keys.map(fmtDay),
      leads: leads.length,
      contacted,
      replied,
      out,
      inc,
      cost,
      costByAction,
      model: usage[usage.length - 1]?.model ?? '—',
      avgScore: leads.length ? Math.round(scoreSum / leads.length) : 0,
      replyRate: out ? Math.round((inc / out) * 100) : 0,
      costPerLead: leads.length ? cost / leads.length : 0,
      costPerReply: replied ? cost / replied : 0,
      medianH,
      runsOk: runs.filter((r) => r.status === 'done').length,
      runsErr: runs.filter((r) => r.status === 'error').length,
      found: runs.reduce((a, r) => a + (r.found ?? 0), 0),
      leadsSeries: keys.map((k) => leadsPerDay[k]),
      outSeries: keys.map((k) => outPerDay[k]),
      inSeries: keys.map((k) => inPerDay[k]),
      costSeries: keys.map((k) => +costPerDay[k].toFixed(4)),
      bySource,
      byStatus,
    }
  }, [data, days])

  if (!data) return <SkelPage stats={8} cards={0} charts={4} />

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Pulpit</h1>
          <p className="sub">
            {proj.name} — co agent znalazł, do kogo napisał, kto odpisał i ile kosztował model.
          </p>
        </div>
        <div className="chips">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d} dni
            </button>
          ))}
        </div>
      </div>

      <div className="hero-band">
        <div className="hb-ic">
          <IcPulse />
        </div>
        <div>
          <div className="hb-label">Odpowiedziało na zimną wiadomość</div>
          <div className="hb-val">
            {S.replyRate} <small>%</small>
          </div>
          <div className="hb-sub">
            {S.inc} odpowiedzi z {S.out} wysłanych wiadomości
          </div>
        </div>
        <div className="right" style={{ textAlign: 'right' }}>
          <div className="hb-label">Koszt jednej odpowiedzi</div>
          <div className="hb-val" style={{ fontSize: 28 }}>
            {S.replied ? usd(S.costPerReply) : '—'}
          </div>
          <div className="hb-sub">model: {S.model}</div>
        </div>
      </div>

      <div className="spacer" />
      <div className="grid g4">
        <StatCard icon={<IcTarget />} label="Znalezione leady" value={S.leads} />
        <StatCard icon={<IcSend />} label="Wysłane wiadomości" value={S.out} />
        <StatCard icon={<IcChat />} label="Odpowiedzi" value={S.inc} tone="var(--ok)" />
        <StatCard icon={<IcSpark />} label="Średnia jakość leada" value={S.avgScore} suffix="/100" />
        <StatCard icon={<IcWallet />} label="Wydatki na model" value={usd(S.cost)} tone="var(--warn)" />
        <StatCard icon={<IcWallet />} label="Koszt jednego leada" value={S.leads ? usd(S.costPerLead) : '—'} />
        <StatCard
          icon={<IcClock />}
          label="Mediana czasu do odpowiedzi"
          value={S.medianH ? (S.medianH < 48 ? `${S.medianH.toFixed(1)} h` : `${(S.medianH / 24).toFixed(1)} dni`) : '—'}
        />
        <StatCard icon={<IcSearch />} label="Przeszukane wyniki" value={S.found} />
      </div>

      <div className="spacer" />
      <div className="grid gch">
        <div className="card chart-card">
          <h3>Nowe leady dziennie</h3>
          <LineChart series={S.leadsSeries} labels={S.labels} unit="leadów" />
          <p className="chart-tip">
            Liczone po dacie dodania do bazy. Duplikaty (ten sam profil, strona albo firma) nie są dodawane drugi raz.
          </p>
        </div>
        <div className="card chart-card">
          <h3>Wysłane vs. odpowiedzi</h3>
          <LineChart series={S.outSeries} labels={S.labels} unit="wysłanych" />
          <LineChart series={S.inSeries} labels={S.labels} unit="odpowiedzi" color="var(--ok)" height={200} />
          <p className="chart-tip">Górny wykres — nasze wiadomości, dolny — odpowiedzi od leadów.</p>
        </div>
        <div className="card chart-card">
          <h3>Wydatki na model dziennie</h3>
          <LineChart series={S.costSeries} labels={S.labels} unit="$" color="var(--warn)" />
          <p className="chart-tip">
            Koszt liczony z tokenów zwróconych przez dostawcę: kwalifikacja leadów, pisanie pierwszej wiadomości
            i odpowiedzi w rozmowach.
          </p>
        </div>
        <div className="card chart-card">
          <h3>Skąd są leady</h3>
          <Donut
            items={Object.entries(S.bySource).map(([k, v], i) => ({
              label: SOURCE_LABEL[k] ?? k,
              value: v,
              color: ['var(--acid)', 'var(--warn)', 'var(--ok)'][i % 3],
            }))}
          />
          <div className="spacer" />
          <h3>Lejek</h3>
          <Bars
            items={[
              { label: 'Znalezione', value: S.leads },
              { label: 'Skontaktowane', value: S.contacted },
              { label: 'Odpowiedziały', value: S.replied },
            ]}
          />
          {!S.leads && <p className="muted">Brak danych w tym okresie — uruchom wyszukiwanie.</p>}
        </div>
        <div className="card chart-card">
          <h3>Na co idą pieniądze</h3>
          <Bars
            items={Object.entries(S.costByAction).map(([k, v]) => ({
              label: { qualify: 'Kwalifikacja leadów', draft: 'Pierwsza wiadomość', reply: 'Odpowiedzi w rozmowie' }[k] ?? k,
              value: +v.toFixed(3),
            }))}
          />
          <p className="chart-tip">
            Kwalifikacja idzie jednym wywołaniem na całą partię — dlatego jest tania mimo dużej liczby leadów.
          </p>
        </div>
        <div className="card chart-card">
          <h3>Stan leadów</h3>
          <Bars
            items={Object.entries(S.byStatus).map(([k, v]) => ({
              label:
                {
                  ready: 'Gotowe do wysyłki',
                  review: 'Do akceptacji',
                  contacted: 'Skontaktowane',
                  replied: 'Odpowiedziały',
                  rejected: 'Odrzucone',
                  failed: 'Błąd wysyłki',
                  archived: 'Archiwum',
                }[k] ?? k,
              value: v,
            }))}
          />
          <p className="chart-tip">
            „Do akceptacji" to leady poniżej progu jakości — agent ich sam nie zaczepia, czekają na Twoją decyzję.
          </p>
        </div>
      </div>
    </>
  )
}
