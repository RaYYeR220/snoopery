import { useEffect, useRef, useState } from 'react';
import { loadRoomPoints, TorchScene } from './torch';
import type { Lang } from '../lib/i18n';
import { href, publicUrl } from '../lib/nav';

const COPY = {
  en: {
    nav: ['How it works', 'Rooms', 'Developers'],
    make: 'Make a room',
    h1: ['Film your room.', 'Every drawer opens.'],
    sub: 'Your friend opens a link and lands inside your room. Every drawer, lid and door opens on its real joint. One of them holds the key, and a solver has already proved they can find it.',
    play: 'Snoop a room',
    mine: 'Make yours',
    proof: 'Built on Aholo Lux3D articulation + Aholo Reality · every room solver-proven',
    hint: 'Move the torch with your pointer · click a lit outline to open it',
    example: 'example room',
    way: "solver's way out",
    steps: 'steps',
    step: 'step',
  },
  zh: {
    nav: ['原理', '房间', '开发者'],
    make: '创建房间',
    h1: ['拍下你的房间。', '每个抽屉都能打开。'],
    sub: '朋友打开链接，就站进了你的房间。每个抽屉、盖子和柜门都沿着真实的关节打开。钥匙就藏在其中一个里，求解器已经证明他们一定能找到。',
    play: '潜入一个房间',
    mine: '做一个你的',
    proof: '基于 Aholo Lux3D 关节动画 + Aholo Reality · 每个房间都经求解器证明',
    hint: '用指针移动手电 · 点击亮起的轮廓即可打开',
    example: '示例房间',
    way: '求解器的最短出路',
    steps: '步',
    step: '第',
  },
} as const;


const LIME: [number, number, number] = [197, 240, 78];
const GROUND: [number, number, number] = [10, 10, 11];

function Odometer({ value }: { value: number }) {
  return (
    <span className="th-odo" aria-hidden="true">
      <span style={{ transform: `translateY(${-value * 1.25}em)` }}>
        {Array.from({ length: 10 }, (_, i) => (
          <i key={i}>{i}</i>
        ))}
      </span>
    </span>
  );
}

export function TorchHero({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }) {
  const hero = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const t = COPY[lang];

  useEffect(() => {
    if (!hero.current || !stage.current || !canvas.current) return;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let last = -1;
    const scene = new TorchScene(stage.current, canvas.current, {
      accent: LIME,
      ground: GROUND,
      reduceMotion,
      onStep: (s) => {
        if (s !== last) {
          last = s;
          setStep(s);
        }
      },
    });
    scene.attach(hero.current);
    let alive = true;
    loadRoomPoints(publicUrl('hero/room.bin'))
      .then((room) => alive && scene.setRoom(room))
      .catch(() => undefined);
    requestAnimationFrame(() => setReady(true));
    return () => {
      alive = false;
      scene.dispose();
    };
  }, []);

  return (
    <section ref={hero} className={`th-hero ${ready ? 'is-ready' : ''}`} aria-labelledby="th-h">
      <div ref={stage} className="th-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label="A filmed room drawn as faint 3D points in the dark. A torch sweeps through it, restoring colour; drawers, a jewellery-box lid and a wardrobe door light up with a thin outline and open on their joints."
        />
      </div>
      <header className="th-nav">
        <div className="th-wrap">
          <a className="th-brand" href={href('/')} aria-label="Snoopery home">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="8.3" stroke="#f2f1ee" strokeWidth="1.3" />
              <circle cx="12.4" cy="8" r="3.4" fill="#c5f04e" />
            </svg>
            <span>Snoopery</span>
          </a>
          <nav className="th-links" aria-label="Primary">
            <a href="#how">{t.nav[0]}</a>
            <a href={href('/rooms')}>{t.nav[1]}</a>
            <a href={href('/docs')}>{t.nav[2]}</a>
          </nav>
          <div className="th-lang" role="group" aria-label="Language">
            <button type="button" aria-pressed={lang === 'en'} onClick={() => onLang('en')}>
              EN
            </button>
            <button type="button" aria-pressed={lang === 'zh'} onClick={() => onLang('zh')}>
              中文
            </button>
          </div>
          <a className="th-nav-cta" href={href('/studio')}>
            {t.make}
          </a>
        </div>
      </header>
      <div className="th-copy">
        <h1 id="th-h" className="th-reveal th-d1">
          <span>{t.h1[0]}</span>
          <span>{t.h1[1]}</span>
        </h1>
        <p className="th-sub th-reveal th-d2">{t.sub}</p>
        <div className="th-ctas th-reveal th-d3">
          <a className="th-btn" href={href('/rooms')}>
            <span>{t.play}</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7h9.5M7.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </a>
          <a className="th-ghost" href={href('/studio')}>
            {t.mine}
          </a>
        </div>
        <p className="th-proof th-reveal th-d4">
          <i aria-hidden="true" />
          <span>{t.proof}</span>
        </p>
      </div>
      <div className="th-foot" aria-live="off">
        <div className="th-wrap">
          <span className="th-left">{t.hint}</span>
          <span>
            {t.example} · <span className="th-long">{t.way} <b>9 {t.steps}</b> · </span>
            <span className="th-lime">
              {t.step} <Odometer value={Math.min(9, step)} /> / 9
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
