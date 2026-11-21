import type { CodeView } from './diff-editor.js';
import { imageDetails, sizeText } from './diff-model.js';
import type { DiffLayout, ImageSide } from './diff-model.js';

// The image view shows one image, or the old and new images of a diff. Split puts the
// sides next to each other, and Unified puts the old side above the new side.
//
// An image shows only in an img element. There, an SVG file cannot run scripts or load
// other files. Each image fits in its side. A click on an image shows all images at
// their actual size, and the next click fits them again. A text side without an image
// shows its text as DOM text, never as HTML.
export function showImages(parent: HTMLElement, sides: ImageSide[], layout: DiffLayout): CodeView {
  const view = document.createElement('div');
  view.className = `image-view ${layout}`;
  const frames: HTMLButtonElement[] = [];
  const setActual = (actual: boolean): void => {
    view.classList.toggle('actual', actual);
    for (const frame of frames) {
      frame.setAttribute('aria-pressed', String(actual));
      frame.title = actual ? 'Fit the image in the pane' : 'Show the image at actual size';
    }
  };
  const images: HTMLImageElement[] = [];
  for (const side of sides) {
    const figure = document.createElement('figure');
    figure.className = 'image-side';
    const caption = document.createElement('figcaption');
    if (side.label) caption.append(textSpan('image-label', side.label));
    const details = textSpan('image-details', side.url ? imageDetails(side) : side.text !== undefined ? `Text · ${sizeText(side.size)}` : '');
    caption.append(details);
    figure.append(caption);
    view.append(figure);
    if (!side.url) {
      if (side.note) figure.append(textSpan('image-note', side.note));
      if (side.text !== undefined) {
        const text = document.createElement('pre');
        text.className = 'image-text';
        text.textContent = side.text;
        figure.append(text);
      }
      continue;
    }
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'image-frame';
    frame.onclick = () => setActual(!view.classList.contains('actual'));
    const image = document.createElement('img');
    image.alt = side.alt;
    image.onload = () => { details.textContent = imageDetails(side, image.naturalWidth, image.naturalHeight); };
    image.onerror = () => {
      frames.splice(frames.indexOf(frame), 1);
      frame.replaceWith(textSpan('image-note', 'The browser cannot show this image.'));
    };
    image.src = side.url;
    images.push(image);
    frames.push(frame);
    frame.append(image);
    figure.append(frame);
  }
  setActual(false);
  parent.append(view);
  return {
    destroy() {
      for (const image of images) image.onload = image.onerror = null;
    },
  };
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}
