// SpeakiRPG mod: mention highlight
// Soft yellow background on chat lines that mention your character name.

let myName = SpeakiRPG.getPlayer()?.playerName ?? null;

SpeakiRPG.on('player', (player) => {
  if (player.playerName) myName = player.playerName;
});

SpeakiRPG.on('chat', (message, row) => {
  if (message.isSystem || message.isMine || !myName || !message.text) return;

  if (message.text.toLowerCase().includes(myName.toLowerCase())) {
    row.style.background = 'rgba(255, 200, 0, 0.12)';
  }
});
