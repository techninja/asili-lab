const ZWJ = '\u200D';
const VS16 = '\uFE0F';
const MALE = `\u2642${VS16}`;
const FEMALE = `\u2640${VS16}`;

// Skin tone modifiers (Fitzpatrick scale)
const SKINS = [
  '',
  '\u{1F3FB}',
  '\u{1F3FC}',
  '\u{1F3FD}',
  '\u{1F3FE}',
  '\u{1F3FF}'
];
const SKIN_COLORS = [
  '#FFCC4D',
  '#FADCBC',
  '#E0BB95',
  '#BF8B68',
  '#9B643D',
  '#594539'
];

// Gender: 0=man, 1=woman, 2=neutral
const _GENDER_LABELS = ['Man', 'Woman', 'Neutral'];

// --- Head-only base characters (no ZWJ = consistent head rendering) ---
// Each "look" is a base codepoint that renders as a head with skin tone support.
// Some use gender signs, some have gendered variants built-in.
const LOOKS = [
  {
    label: 'Default',
    icon: '🧑',
    // [man, woman, neutral] base codepoints
    bases: ['\u{1F468}', '\u{1F469}', '\u{1F9D1}'],
    usesGenderSign: false
  },
  {
    label: 'Blond',
    icon: '👱',
    bases: ['\u{1F471}', '\u{1F471}', '\u{1F471}'],
    usesGenderSign: true // 👱‍♂️ 👱‍♀️ 👱
  },
  {
    label: 'Beard',
    icon: '🧔',
    bases: ['\u{1F9D4}', '\u{1F9D4}', '\u{1F9D4}'],
    usesGenderSign: true // 🧔‍♂️ 🧔‍♀️ 🧔
  },
  {
    label: 'Older',
    icon: '🧓',
    bases: ['\u{1F474}', '\u{1F475}', '\u{1F9D3}'],
    usesGenderSign: false // 👴 👵 🧓 are distinct codepoints
  }
];

// --- ZWJ hair components (these produce busts with shoulders) ---
const HAIR_MODS = [
  { label: 'Red Hair', icon: '🦰', mod: '\u{1F9B0}' },
  { label: 'Curly', icon: '🦱', mod: '\u{1F9B1}' },
  { label: 'White Hair', icon: '🦳', mod: '\u{1F9B3}' },
  { label: 'Bald', icon: '🦲', mod: '\u{1F9B2}' }
];

const GENDER_SIGNS = [MALE, FEMALE, null];

function buildEmoji(gender, skin, lookIdx, hairIdx) {
  // If a hair modifier is selected, use ZWJ sequence (renders as bust)
  if (hairIdx >= 0) {
    const defaultBases = LOOKS[0].bases;
    return defaultBases[gender] + SKINS[skin] + ZWJ + HAIR_MODS[hairIdx].mod;
  }
  // Otherwise use the look's base character (renders as head)
  const look = LOOKS[lookIdx];
  let e = look.bases[gender] + SKINS[skin];
  if (look.usesGenderSign && GENDER_SIGNS[gender]) {
    e += ZWJ + GENDER_SIGNS[gender];
  }
  return e;
}

export class EmojiBuilder extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._gender = 0;
    this._skin = 0;
    this._look = 0; // index into LOOKS
    this._hair = -1; // -1 = none, 0+ = index into HAIR_MODS
  }

  connectedCallback() {
    this.render();
  }

  get value() {
    return buildEmoji(this._gender, this._skin, this._look, this._hair);
  }

  set value(emoji) {
    if (!emoji) return;
    this._parseEmoji(emoji);
    this.render();
  }

  _parseEmoji(emoji) {
    // Detect skin tone
    this._skin = SKINS.findIndex((s, i) => i > 0 && emoji.includes(s));
    if (this._skin < 0) this._skin = 0;

    // Detect ZWJ hair modifier
    const hi = HAIR_MODS.findIndex(h => emoji.includes(h.mod));
    if (hi >= 0) {
      this._hair = hi;
      this._look = 0;
      // Detect gender from base
      this._gender = LOOKS[0].bases.findIndex(b => emoji.startsWith(b));
      if (this._gender < 0) this._gender = 0;
      return;
    }
    this._hair = -1;

    // Detect look + gender from base character (strip skin tone for matching)
    const stripped = emoji.replace(
      new RegExp(`[${SKINS.slice(1).join('')}]`, 'u'),
      ''
    );
    for (let li = 0; li < LOOKS.length; li++) {
      for (let gi = 0; gi < 3; gi++) {
        const candidate = LOOKS[li].bases[gi];
        if (stripped.startsWith(candidate)) {
          this._look = li;
          this._gender = gi;
          // For gender-sign looks, prefer the gender that matches the sign
          if (LOOKS[li].usesGenderSign) {
            if (stripped.includes(MALE)) this._gender = 0;
            else if (stripped.includes(FEMALE)) this._gender = 1;
            else this._gender = 2;
          }
          return;
        }
      }
    }
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change', { detail: this.value }));
  }

  _set(key, val) {
    if (key === 'gender') this._gender = val;
    else if (key === 'skin') this._skin = val;
    else if (key === 'look') {
      this._look = val;
      this._hair = -1;
    } else if (key === 'hair') {
      // Toggle: clicking same hair again deselects it
      this._hair = this._hair === val ? -1 : val;
      if (this._hair >= 0) this._look = 0; // reset look when hair selected
    }
    this.render();
    this._emit();
  }

  render() {
    const preview = this.value;
    const isHairActive = this._hair >= 0;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .preview { font-size: 48px; text-align: center; padding: 8px 0; line-height: 1; }
        .row { display: flex; align-items: center; gap: 4px; margin: 6px 0; flex-wrap: wrap; }
        .lbl { font-size: 11px; color: #888; min-width: 44px; text-transform: uppercase; }
        .opt {
          border: 2px solid transparent; background: #f5f5f5; border-radius: 6px;
          cursor: pointer; font-size: 20px; padding: 4px 6px; line-height: 1;
          transition: border-color .1s, opacity .1s;
        }
        .opt:hover { background: #e9ecef; }
        .opt.sel { border-color: #007acc; background: #e3f2fd; }
        .opt.dim { opacity: 0.35; }
        .dot {
          width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent;
          cursor: pointer; transition: border-color .1s;
        }
        .dot:hover { border-color: #999; }
        .dot.sel { border-color: #007acc; box-shadow: 0 0 0 2px #007acc44; }
        .sep { width: 1px; height: 20px; background: #ddd; margin: 0 4px; }
        .note { font-size: 10px; color: #aaa; margin-left: 4px; }
      </style>
      <div class="preview">${preview}</div>
      <div class="row">
        <span class="lbl">Gender</span>
        ${LOOKS[0].bases.map((b, i) => `<button class="opt ${this._gender === i ? 'sel' : ''}" data-k="gender" data-v="${i}">${b}</button>`).join('')}
      </div>
      <div class="row">
        <span class="lbl">Skin</span>
        ${SKINS.map((_, i) => `<span class="dot ${this._skin === i ? 'sel' : ''}" data-k="skin" data-v="${i}" style="background:${SKIN_COLORS[i]}"></span>`).join('')}
      </div>
      <div class="row">
        <span class="lbl">Style</span>
        ${LOOKS.map((l, i) => `<button class="opt ${!isHairActive && this._look === i ? 'sel' : ''} ${isHairActive ? 'dim' : ''}" data-k="look" data-v="${i}">${l.icon}</button>`).join('')}
        <span class="sep"></span>
        ${HAIR_MODS.map((h, i) => `<button class="opt ${this._hair === i ? 'sel' : ''} ${!isHairActive && this._hair !== i ? '' : ''}" data-k="hair" data-v="${i}">${h.icon}</button>`).join('')}
        ${isHairActive ? '<span class="note">bust style</span>' : ''}
      </div>
    `;

    this.shadowRoot.querySelectorAll('[data-k]').forEach(el => {
      el.onclick = () => this._set(el.dataset.k, parseInt(el.dataset.v));
    });
  }
}

customElements.define('emoji-builder', EmojiBuilder);
