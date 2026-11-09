// Call directly from the button gesture: Safari requires clipboard writes before any await.
export async function copySignInCode({text,field,feedback,hideField=false}) {
 text=String(text||'').trim();
 if(!text){feedback.textContent='Request a sign-in code first.';return false;}
 try {
  if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
  feedback.textContent='Code copied.';if(hideField)field.hidden=true;return true;
 }catch{}
 // Read-only inputs support selection on iOS without opening the keyboard.
 field.hidden=false;if(field.value!==text)field.value=text;field.focus({preventScroll:true});field.select();field.setSelectionRange(0,text.length);
 try {
  if(document.execCommand('copy')){feedback.textContent='Code copied.';if(hideField)field.hidden=true;return true;}
 }catch{}
 feedback.textContent='Copy was blocked. Touch and hold the selected code, then choose Copy.';
 return false;
}
