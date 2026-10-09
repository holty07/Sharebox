/**
 * src/bcrypt.d.ts — minimal ambient module declaration for bcryptjs
 * (the typed @types/bcryptjs package is not installed here).
 */
declare module 'bcryptjs' {
  const bcrypt: {
    (password: string, rounds?: number): Promise<string>;
    compare(password: string, hash: string): Promise<boolean>;
  };
  export default bcrypt;
}
