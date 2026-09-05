import { mount } from "svelte";
import App from "./App.svelte";
import "./m3.css";

const app = mount(App, { target: document.getElementById("app") });

export default app;
