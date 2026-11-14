/** Only an opaque, one-use loopback bridge page may enter the editor UI. */
export function isLocalLoginPage(value){
  if(typeof value!=='string')return false;
  const match=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/sign-in\/[A-Za-z0-9_-]{43}$/.exec(value);
  return Boolean(match&&match[0]===value&&Number(match[1])<=65535);
}
