import Modal from './Modal';
import { BRAND_ICON, BRAND_NAME, SOURCE_URL } from '../brand';

declare const __ALDINE_VERSION__: string;
declare const __ALDINE_REV__: string;


/**
 * AGPL section 13: anyone interacting with this instance over a network must be
 * offered the source of the version they are interacting with. That is what the
 * build stamp below is for — an operator running modified code has to point
 * SOURCE_URL at their own fork.
 */
export default function About({ onClose }: { onClose: () => void }) {
  const rev = __ALDINE_REV__;
  return (
    <Modal onClose={onClose} label={`About ${BRAND_NAME}`} testId="about-modal" width={460}>
      <h2 className="about__title"><img src={BRAND_ICON} alt="" aria-hidden="true" width={40} height={40} /> {BRAND_NAME}</h2>
      <p className="modal__sub">
        Collaborative LaTeX with a research-writing assistant, based on{' '}
        <a href="https://github.com/trahloff/Aldine" target="_blank" rel="noreferrer">Aldine</a>, the slim, self-hosted LaTeX platform. Version {__ALDINE_VERSION__}
        {rev ? <> · build <code>{rev}</code></> : null}
      </p>
      <p className="modal__sub">
        Licensed under the{' '}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
          GNU Affero General Public License v3
        </a>
        . You are entitled to the complete source of the version running here,
        including any changes this instance&rsquo;s operator has made to it.
      </p>
      <div className="modal__row">
        <button className="btn" onClick={onClose}>Close</button>
        <a
          className="btn btn--primary"
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="about-source"
        >
          Get the source
        </a>
      </div>
    </Modal>
  );
}
