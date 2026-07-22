// qrcode-terminal ships no types and we use one function. One line beats a dep.
declare module "qrcode-terminal" {
  const q: { generate(text: string, opts?: { small?: boolean }): void };
  export default q;
}
