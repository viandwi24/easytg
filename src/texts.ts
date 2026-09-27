/** Every user-facing string easytg sends by itself. Override via `new EasyTG({ texts })`. */
export interface EasyTGTexts {
  home: string;
  back: string;
  close: string;
  cancel: string;
  done: string;
  pageNotFound: string;
  error: string;
  invalidInput: string;
  expectText: string;
  expectFile: string;
  expectChoice: string;
  buttonExpired: string;
  notYourMenu: string;
  busy: string;
  spam: (seconds: number) => string;
  closeMenu: string;
  menuClosed: string;
  shareContact: string;
  shareLocation: string;
  expectContact: string;
  expectLocation: string;
  contactNotYours: string;
  /** Sent after a step with reply-keyboard buttons, to put the menu back. */
  received: string;
  /** Sent when a dialogue with reply-keyboard buttons is cancelled, to put the menu back. */
  cancelled: string;
  collectMin: (min: number) => string;
  collectReceived: (count: { total: number; texts: number; files: number }) => string;
  collectLimit: (max: number) => string;
}

export const defaultTexts: EasyTGTexts = {
  home: '🏠 Home',
  back: '⬅️ Back',
  close: '❌ Close',
  cancel: '❌ Cancel',
  done: '✅ Done',
  pageNotFound: 'Page not found.',
  error: 'Something went wrong, please try again.',
  invalidInput: 'Invalid input, please try again.',
  expectText: 'Please send a text message.',
  expectFile: 'Please send a file of the requested type.',
  expectChoice: 'Please choose one of the buttons.',
  buttonExpired: 'This button is no longer active.',
  notYourMenu: 'This menu belongs to someone else.',
  busy: '⏳ Please wait…',
  spam: (seconds) => `🐢 Too many requests. Please wait ${seconds}s.`,
  closeMenu: '✖️ Close menu',
  menuClosed: 'Menu closed.',
  shareContact: '📱 Share my contact',
  shareLocation: '📍 Share my location',
  expectContact: 'Please use the button below to share your contact.',
  expectLocation: 'Please use the button below to share your location.',
  contactNotYours: 'Please share your own contact.',
  received: '👍 Got it.',
  cancelled: 'Cancelled.',
  collectMin: (min) => (min <= 1 ? "You haven't sent anything yet." : `Please send at least ${min} items.`),
  collectReceived: ({ total }) => `Received ${total} item(s). Send more, or press ✅ Done.`,
  collectLimit: (max) => `You can send at most ${max} items. Press ✅ Done to continue.`,
};
