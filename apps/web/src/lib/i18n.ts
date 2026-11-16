import { useEffect, useState } from 'react';

export type Lang = 'en' | 'zh';

const KEY = 'snoopery.lang';
const listeners = new Set<(l: Lang) => void>();

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current: Lang = initial();

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  listeners.forEach((f) => f(l));
}

/** The page language, shared by every component and remembered per browser. */
export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, set] = useState<Lang>(current);
  useEffect(() => {
    listeners.add(set);
    document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
    return () => void listeners.delete(set);
  }, []);
  return [lang, setLang];
}

export const T = {
  en: {
    how: [
      ['Film', 'Walk your room with a phone for a minute. Aholo Reality rebuilds it as a 3D splat you can walk through.'],
      ['Photograph', 'Snap the things that open. Aholo Lux3D makes each one at true scale, then articulation makes its drawers slide and its lids swing.'],
      ['Hide', 'An AI tucks keys and clues into those parts. A solver searches every state of the room and only lets it out if there is a way to escape.'],
      ['Share', 'Send the link. Your friend snoops through your actual room, one drawer at a time.'],
    ],
    proofTitle: 'Proven, not hoped.',
    proofLead: 'Ask a language model to design an escape room and it will happily lock the key inside the box it opens. We measured it on 40 rooms.',
    proofA: 'of rooms a model designs in one go can actually be escaped',
    proofB: "escapable after Snoopery's solver sends its counterexamples back to the model",
    proofTail: 'Every published room carries its proof: the shortest way out, re-checked when you publish and used for hints while you play.',
    robotTitle: "Your room is also a robot's homework.",
    robotText: 'The joints Snoopery recovers are real slides and hinges with axes and limits. Every room exports as a MuJoCo scene and a USD stage, with the solver’s steps as the task: open this drawer to 300 mm, take the note, enter 0412.',
    robotLink: 'For developers and robots',
    builtTitle: "Built on Manycore's Aholo",
    built: [
      ['Lux3D', 'image→3D, part split, articulation, rigging'],
      ['Reality', 'room reconstruction from a phone video'],
      ['SpatialGen', 'rooms from a sentence'],
      ['Aholo Viewer', 'splats and furniture in one scene'],
      ['splat-transform', 'walk collision'],
    ],
    rooms: 'Rooms',
    make: 'Make a room',
    devs: 'Developers',
    // player
    loading: 'Loading the room…',
    steps: 'steps',
    shortest: 'shortest',
    soundOn: 'Sound on',
    soundOff: 'Sound off',
    hint: 'Hint',
    watch: 'Watch the solution',
    door: 'Try the door',
    pockets: 'Your pockets are empty. Open things.',
    plainSight: 'In plain sight',
    found: 'Found',
    picked: 'Picked up',
    takes: 'Takes',
    empty: 'Empty.',
    lockedKey: 'Locked. It needs a key.',
    doorLocked: 'The door is locked.',
    haveAll: 'You have what you need. Try the door.',
    lookAt: 'Look at the',
    lyingAround: 'Something is lying in plain sight',
    outDoor: 'Out the door.',
    codeLock: (part: string) => `The ${part} has a code lock`,
    pocket: 'Put it in my pocket',
    start: 'Start snooping',
    someones: 'Someone’s room',
    whose: (a: string) => `${a}'s room`,
    howto: ['Drag to look around · click the floor (or WASD) to walk', 'Click drawers, lids and doors — they really open', 'Find what you need, then try the door'],
    proven: (n: number) => `The way out is proven: the shortest escape takes ${n} steps.`,
    gotOut: 'You got out',
    result: (s: number, m: number, h: number) => `${s} steps (the shortest way out is ${m}) · ${h} hints`,
    name: 'Your name',
    save: 'Save my time',
    saveFail: 'Could not save right now.',
    copy: 'Copy the link for a friend',
    asRobot: 'Same room as a robot task:',
  },
  zh: {
    how: [
      ['拍摄', '用手机在房间里走一分钟。Aholo Reality 把它重建成可以走进去的 3D 高斯泼溅场景。'],
      ['拍照', '拍下能打开的家具。Aholo Lux3D 按真实尺寸生成模型，关节动画让抽屉滑出、盖子翻开。'],
      ['藏起来', 'AI 把钥匙和线索藏进这些部件。求解器搜索房间的每一种状态，只有确实能逃出去才允许发布。'],
      ['分享', '发出链接。朋友会在你真实的房间里一个抽屉一个抽屉地翻找。'],
    ],
    proofTitle: '是证明，不是碰运气。',
    proofLead: '让大模型直接设计密室，它常常会把钥匙锁进它要打开的盒子里。我们在 40 个房间上做了测量。',
    proofA: '的房间由模型一次性设计后真的能逃出去',
    proofB: '个房间在 Snoopery 求解器把反例发回给模型后都能逃出',
    proofTail: '每个发布的房间都带着它的证明：最短出路，发布时再次检查，游戏中的提示也由它给出。',
    robotTitle: '你的房间也是机器人的作业。',
    robotText: 'Snoopery 还原的关节是真实的滑轨和铰链，带有轴和限位。每个房间都能导出为 MuJoCo 场景和 USD 舞台，求解器的步骤就是任务：把这个抽屉拉开 300 毫米，拿走纸条，输入 0412。',
    robotLink: '面向开发者和机器人',
    builtTitle: '基于群核科技 Aholo 构建',
    built: [
      ['Lux3D', '图生 3D、部件拆分、关节动画、骨骼绑定'],
      ['Reality', '用手机视频重建房间'],
      ['SpatialGen', '一句话生成房间'],
      ['Aholo Viewer', '泼溅与家具同场渲染'],
      ['splat-transform', '行走碰撞'],
    ],
    rooms: '房间',
    make: '创建房间',
    devs: '开发者',
    loading: '正在载入房间…',
    steps: '步',
    shortest: '最短',
    soundOn: '声音开',
    soundOff: '声音关',
    hint: '提示',
    watch: '看解法',
    door: '试试开门',
    pockets: '口袋还是空的。去打开东西吧。',
    plainSight: '就在眼前',
    found: '找到',
    picked: '拿起',
    takes: '拿走',
    empty: '空的。',
    lockedKey: '锁住了，需要钥匙。',
    doorLocked: '门是锁着的。',
    haveAll: '需要的都拿到了，去开门吧。',
    lookAt: '看看',
    lyingAround: '有东西就摆在眼前',
    outDoor: '出门了。',
    codeLock: (part: string) => `${part}上有密码锁`,
    pocket: '放进口袋',
    start: '开始翻找',
    someones: '某人的房间',
    whose: (a: string) => `${a}的房间`,
    howto: ['拖动环顾四周 · 点击地面（或 WASD）移动', '点击抽屉、盖子和柜门——它们真的能打开', '找到需要的东西，然后去开门'],
    proven: (n: number) => `出路已被证明：最短逃脱需要 ${n} 步。`,
    gotOut: '你逃出来了',
    result: (s: number, m: number, h: number) => `${s} 步（最短出路 ${m} 步）· ${h} 次提示`,
    name: '你的名字',
    save: '保存我的成绩',
    saveFail: '暂时无法保存。',
    copy: '复制链接发给朋友',
    asRobot: '同一个房间作为机器人任务：',
  },
} as const;

export type Dict = (typeof T)['en'];
export const dict = (l: Lang): Dict => T[l] as unknown as Dict;
