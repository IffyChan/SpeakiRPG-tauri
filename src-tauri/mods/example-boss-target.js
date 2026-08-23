// SpeakiRPG mod: boss target hint
// Subtle red outline on the target bar while a BOSS is selected.

const BOSS_STYLE = '0 0 0 2px rgba(220, 80, 80, 0.55)';

SpeakiRPG.on('target', (target, frame) => {
  if (!frame) return;
  frame.style.boxShadow = target.hasTarget && target.isBoss ? BOSS_STYLE : '';
});

// paint current state if we load mid-fight
const current = SpeakiRPG.getTarget();
if (current?.hasTarget && current.isBoss) {
  const frame = SpeakiRPG.query('.sr-target-frame');
  if (frame) frame.style.boxShadow = BOSS_STYLE;
}
