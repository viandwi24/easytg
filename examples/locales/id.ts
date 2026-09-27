import type { EasyTGTexts } from '../../src';

/**
 * Indonesian translation of easytg's built-in texts. easytg itself only ships
 * English; add languages like this:
 *
 *   new EasyTG({ i18n: { locales: { id } } })
 */
export const id: EasyTGTexts = {
  home: '🏠 Beranda',
  back: '⬅️ Kembali',
  close: '❌ Tutup',
  cancel: '❌ Batal',
  done: '✅ Selesai',
  pageNotFound: 'Halaman tidak ditemukan.',
  error: 'Terjadi kesalahan, silakan coba lagi.',
  invalidInput: 'Input tidak valid, coba lagi.',
  expectText: 'Silakan kirim pesan teks.',
  expectFile: 'Silakan kirim file dengan jenis yang diminta.',
  expectChoice: 'Silakan pilih salah satu tombol.',
  buttonExpired: 'Tombol ini sudah tidak berlaku.',
  notYourMenu: 'Menu ini milik pengguna lain.',
  busy: '⏳ Mohon tunggu…',
  spam: (seconds) => `🐢 Terlalu banyak permintaan. Tunggu ${seconds} detik.`,
  closeMenu: '✖️ Tutup menu',
  menuClosed: 'Menu ditutup.',
  shareContact: '📱 Bagikan kontak saya',
  shareLocation: '📍 Bagikan lokasi saya',
  expectContact: 'Silakan tekan tombol di bawah untuk membagikan kontak Anda.',
  expectLocation: 'Silakan tekan tombol di bawah untuk membagikan lokasi Anda.',
  contactNotYours: 'Silakan bagikan kontak Anda sendiri.',
  received: '👍 Diterima.',
  cancelled: 'Dibatalkan.',
  collectMin: (min) => (min <= 1 ? 'Anda belum mengirim apa pun.' : `Kirim minimal ${min} item.`),
  collectReceived: ({ total }) => `Diterima ${total} item. Kirim lagi, atau tekan ✅ Selesai.`,
  collectLimit: (max) => `Maksimal ${max} item. Tekan ✅ Selesai untuk melanjutkan.`,
};
