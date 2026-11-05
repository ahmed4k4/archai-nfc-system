import { auth, db, firebaseConfig } from './firebase.js';
import {
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
  deleteUser,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

export async function login(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);

  try {
    const profileSnapshot = await getDoc(doc(db, 'users', credential.user.uid));
    if (!profileSnapshot.exists() || profileSnapshot.data().active !== true) {
      throw new Error('هذا الحساب غير مفعل أو غير معتمد.');
    }

    const profile = profileSnapshot.data();
    if (!['super_admin', 'brand_admin'].includes(profile.role)) {
      throw new Error('نوع الحساب غير مصرح له بالدخول.');
    }

    if (profile.role === 'brand_admin') {
      if (typeof profile.brandId !== 'string' || !profile.brandId) {
        throw new Error('حساب مدير البراند غير مرتبط ببراند. تواصل مع مدير النظام.');
      }
      const brandSnapshot = await getDoc(doc(db, 'brands', profile.brandId));
      if (!brandSnapshot.exists() || brandSnapshot.data().active !== true) {
        throw new Error('حساب البراند متوقف حالياً. تواصل مع مدير النظام.');
      }
    }

    return { user: credential.user, profile };
  } catch (error) {
    try {
      if (auth.currentUser?.uid === credential.user.uid) await signOut(auth);
    } catch {
      // Preserve the original authentication/profile error.
    }
    throw error;
  }
}

export async function logout() {
  return signOut(auth);
}

// Create instructor accounts in a secondary Auth instance so the current
// super-admin session is not replaced by the newly created brand-admin user.
export async function createBrandAccount(email, password, profile) {
  const secondary = initializeApp(firebaseConfig, `secondary-${crypto.randomUUID()}`);
  const { getAuth } = await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js');
  const secondaryAuth = getAuth(secondary);
  let createdCredential = null;
  let profileSaved = false;

  try {
    createdCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await setDoc(doc(db, 'users', createdCredential.user.uid), {
      ...profile,
      role: 'brand_admin',
      active: true,
      createdAt: serverTimestamp(),
    });
    profileSaved = true;
    return createdCredential.user.uid;
  } catch (error) {
    // Avoid leaving an orphaned Auth account when the matching Firestore
    // profile could not be created. Do not roll back after profile success.
    if (createdCredential && !profileSaved) {
      try {
        await deleteUser(createdCredential.user);
      } catch {
        // The original Firestore/Auth error is more useful to the caller.
      }
    }
    throw error;
  } finally {
    try {
      if (secondaryAuth.currentUser) await signOut(secondaryAuth);
    } catch {
      // Secondary session is discarded with its app instance below.
    }
    try {
      await deleteApp(secondary);
    } catch {
      // The secondary app is temporary; cleanup failure must not hide the operation result.
    }
  }
}
