import {
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { db } from './firebase.js';

export const col = (name) => collection(db, name);

export async function list(name, constraints = []) {
  const snapshot = await getDocs(query(col(name), ...constraints));
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

export async function one(name, id) {
  const snapshot = await getDoc(doc(db, name, id));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function add(name, data) {
  return addDoc(col(name), { ...data, createdAt: serverTimestamp() });
}

export async function put(name, id, data) {
  return setDoc(doc(db, name, id), data, { merge: true });
}

export async function patch(name, id, data) {
  return updateDoc(doc(db, name, id), data);
}

export async function remove(name, id) {
  return deleteDoc(doc(db, name, id));
}

export { where, serverTimestamp, doc };

export function batch() {
  return writeBatch(db);
}
