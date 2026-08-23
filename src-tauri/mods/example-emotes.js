// SpeakiRPG mod: emote slot demo
// Calls clickEmoteSlot() once when the hotbar emote button appears.

(function () {
  function tryOnce() {
    if (SpeakiRPG.clickEmoteSlot()) return;
    setTimeout(tryOnce, 250);
  }

  tryOnce();
})();
