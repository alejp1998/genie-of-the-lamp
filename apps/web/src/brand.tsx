import type { CSSProperties } from 'react';
import icon from './assets/genie-icon.png';

/** This fork's name and where its source lives (the About dialog's AGPL source offer points here). */
export const BRAND_NAME = 'LaTeX Genie';
export const SOURCE_URL = 'https://github.com/alejp1998/genie-of-the-lamp';
export const BRAND_ICON = icon;

/** The wordmark on the home, sign-in and consent pages: the genie and "LaTeX Genie". */
export function BrandMark({ style }: { style?: CSSProperties }) {
  return (
    <h1 className="home__brand" style={style}>
      <img className="home__brand-icon" src={icon} alt="" aria-hidden="true" />
      LaTeX <em>Genie</em>
    </h1>
  );
}
