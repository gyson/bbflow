// The on-screen keyboard of a phone covers the lower part of the page. The browser
// keeps the height of the page and makes only the visual viewport smaller. Then it
// scrolls the page to show the control that has the focus. followKeyboard gives the
// page the position and the height of the visual viewport while the keyboard shows, so
// that the page stays complete above the keyboard.

// A smaller difference between the page and the visual viewport is not a keyboard. The
// bar of a hardware keyboard and a browser toolbar are lower than this height.
const minKeyboard = 150;

// Return the height that the on-screen keyboard covers, in CSS pixels, or 0 for no
// keyboard. pageHeight is the height of the layout viewport. A pinch zoom also makes
// the visual viewport smaller. A zoomed page gets 0.
export function keyboardHeight(pageHeight: number, view: { height: number; scale: number }): number {
  if (Math.abs(view.scale - 1) > 0.01) return 0;
  const covered = Math.round(pageHeight - view.height);
  return covered >= minKeyboard ? covered : 0;
}

let shown = false;

// keyboardShown tells whether the on-screen keyboard covers a part of the page.
export function keyboardShown(): boolean {
  return shown;
}

// followKeyboard sets the `keyboard` class of the root element while the on-screen
// keyboard shows. It sets the height and the top position of the visual viewport in
// --viewport-height and --viewport-top. The style sheet gives them to the page.
export function followKeyboard(): void {
  const view = window.visualViewport;
  if (!view) return;
  const root = document.documentElement;
  const update = () => {
    // Safari on iOS gives window.innerHeight the height of the visual viewport some time
    // after the keyboard shows. The height of the root element stays.
    shown = keyboardHeight(root.clientHeight, view) > 0;
    if (shown) {
      root.style.setProperty('--viewport-height', `${view.height}px`);
      // The browser can scroll the page below the keyboard. pageTop includes that scroll.
      root.style.setProperty('--viewport-top', `${view.pageTop}px`);
    } else {
      root.style.removeProperty('--viewport-height');
      root.style.removeProperty('--viewport-top');
    }
    root.classList.toggle('keyboard', shown);
  };
  view.addEventListener('resize', update);
  view.addEventListener('scroll', update);
  // A scroll of the page changes pageTop without a scroll event of the visual viewport.
  window.addEventListener('scroll', update);
  update();
}
