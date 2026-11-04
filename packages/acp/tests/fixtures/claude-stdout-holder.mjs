import { connect } from "node:net";

const socket = connect(Number(process.env.FAKE_CLAUDE_CLOSE_GATE_PORT), "127.0.0.1");
const onData = (data) => {
  if (data.toString().includes("release")) {
    socket.end();
  } else {
    socket.write("held\n");
  }
};
const onClose = () => {
  socket.off("data", onData);
  socket.off("close", onClose);
};
socket.on("close", onClose);
socket.on("data", onData);
socket.write("ready\n");
