import type { ReactNode } from 'react';
import { TorchHero } from '../hero/TorchHero';
import { dict, useLang } from '../lib/i18n';
import { href } from '../lib/nav';


/** The landing page; the hero is swappable so the art direction can change without touching the rest. */
export function Landing({ hero }: { hero?: ReactNode }) {
  const [lang, setLang] = useLang();
  const d = dict(lang);
  return (
    <main className="sn-landing">
      {hero ?? <TorchHero lang={lang} onLang={setLang} />}

      <section className="sn-band" id="how">
        <ol className="sn-verbs">
          {d.how.map(([verb, text], i) => (
            <li key={verb}>
              <span className="sn-verb-n">{String(i + 1).padStart(2, '0')}</span>
              <strong>{verb}</strong>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="sn-band sn-proof">
        <h2>{d.proofTitle}</h2>
        <p className="sn-muted">{d.proofLead}</p>
        <div className="sn-figures">
          <div>
            <span className="sn-figure">15%</span>
            <span>{d.proofA}</span>
          </div>
          <div>
            <span className="sn-figure sn-accent">40 / 40</span>
            <span>{d.proofB}</span>
          </div>
        </div>
        <p className="sn-muted">{d.proofTail}</p>
      </section>

      <section className="sn-band">
        <h2>{d.robotTitle}</h2>
        <p className="sn-muted">{d.robotText}</p>
        <a className="sn-cta-ghost" href={href('/docs')}>{d.robotLink}</a>
      </section>

      <section className="sn-band sn-built">
        <h2>{d.builtTitle}</h2>
        <ul>
          {d.built.map(([name, what]) => (
            <li key={name}>
              <strong>{name}</strong> {what}
            </li>
          ))}
        </ul>
      </section>

      <footer className="sn-footer">
        <a href={href('/rooms')}>{d.rooms}</a>
        <a href={href('/studio')}>{d.make}</a>
        <a href={href('/docs')}>{d.devs}</a>
      </footer>
    </main>
  );
}
