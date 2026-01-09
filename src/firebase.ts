import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDKQWUpBlfcfijkyi1p8UYOLgaYx9Y7CVE",
  authDomain: "daycare-tracker-534a3.firebaseapp.com",
  projectId: "daycare-tracker-534a3",
  storageBucket: "daycare-tracker-534a3.firebasestorage.app",
  messagingSenderId: "748774632024",
  appId: "1:748774632024:web:48e4f70a7f990e3bed382d"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
