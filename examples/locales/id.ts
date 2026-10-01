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
  adminOnly: 'Hanya admin grup yang bisa melakukan ini.',
  spam: (seconds) => `🐢 Terlalu banyak permintaan. Tunggu ${seconds} detik.`,
  closeMenu: '✖️ Tutup menu',
  menuClosed: 'Menu ditutup.',
  shareContact: '📱 Bagikan kontak saya',
  shareLocation: '📍 Bagikan lokasi saya',
  expectContact: 'Silakan tekan tombol di bawah untuk membagikan kontak Anda.',
  expectLocation: 'Silakan tekan tombol di bawah untuk membagikan lokasi Anda.',
  openWebApp: '📱 Buka',
  expectWebApp: 'Silakan gunakan tombol di bawah.',
  contactNotYours: 'Silakan bagikan kontak Anda sendiri.',
  received: '👍 Diterima.',
  cancelled: 'Dibatalkan.',
  collectMin: (min) => (min <= 1 ? 'Anda belum mengirim apa pun.' : `Kirim minimal ${min} item.`),
  collectReceived: ({ total, done }) => `Diterima ${total} item. Kirim lagi, atau tekan ${done}.`,
  collectLimit: ({ max, done }) => `Maksimal ${max} item. Tekan ${done} untuk melanjutkan.`,
  chooseAtLeast: (min) => (min <= 1 ? 'Pilih minimal satu opsi.' : `Pilih minimal ${min} opsi.`),
  chooseAtMost: (max) => `Anda hanya bisa memilih maksimal ${max}.`,
  expectNumber: ({ min, max }) =>
    min !== undefined && max !== undefined ? `Kirim angka dari ${min} sampai ${max}.` : min !== undefined ? `Kirim angka minimal ${min}.` : max !== undefined ? `Kirim angka maksimal ${max}.` : 'Kirim sebuah angka.',
  expectDate: 'Pilih tanggal, atau kirim seperti 2026-12-31.',
};
