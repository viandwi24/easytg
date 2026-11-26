/** The hero bot's products: placeholder photos with the product's name. */
const photo = (name: string, color: string) => `https://placehold.co/640x400/${color}/ffffff/png?font=montserrat&text=${encodeURIComponent(name)}`;

export const products = [
  { id: 'tee', name: 'Classic tee', price: 19, about: 'Soft cotton, every size.', photo: photo('Classic tee', '5b8a68') },
  { id: 'hoodie', name: 'Hoodie', price: 42, about: 'Warm, with a front pocket.', photo: photo('Hoodie', 'b9785a') },
  { id: 'cap', name: 'Cap', price: 15, about: 'One size, adjustable strap.', photo: photo('Cap', '5f74a3') },
];
