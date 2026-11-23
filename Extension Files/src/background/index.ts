chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
      // Ignore if sidePanel behavior cannot be configured in this Chrome channel.
    });
  }
});

chrome.runtime.onMessage.addListener((message: { type?: string }, sender, sendResponse) => {
  if (message?.type === 'AMISYNC_TOGGLE_OVERLAY' || message?.type === 'AMISYNC_CLOSE_OVERLAY') {
    const targetTabId = sender.tab?.id;
    if (typeof targetTabId === 'number') {
      void chrome.tabs.sendMessage(targetTabId, { type: message.type }).catch(() => {
        // Content script may not be mounted on non-AMIS tabs.
      });
    } else {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        if (typeof activeTab?.id === 'number') {
          return chrome.tabs.sendMessage(activeTab.id, { type: message.type }).catch(() => {});
        }
        return undefined;
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
