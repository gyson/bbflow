export function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing or invalid UI element: ${id}`);
  return node;
}

// revealCard scrolls to a card of Settings and moves the focus to its heading. It
// scrolls only the nearest scroll area, because scrollIntoView would also move the page.
// The bar of Settings stays at the top of that area, so the card goes below the bar.
export function revealCard(card: HTMLElement, heading: HTMLElement): void {
  let area = card.parentElement;
  while (area && !(area.scrollHeight > area.clientHeight && /auto|scroll/.test(getComputedStyle(area).overflowY))) area = area.parentElement;
  if (area) {
    const bar = area.querySelector('.settings-actions')?.getBoundingClientRect().height ?? 0;
    area.scrollTop += card.getBoundingClientRect().top - area.getBoundingClientRect().top - bar;
  }
  heading.focus({ preventScroll: true });
}
