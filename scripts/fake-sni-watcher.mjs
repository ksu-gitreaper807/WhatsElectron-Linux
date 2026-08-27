#!/usr/bin/env node
/**
 * A deliberately minimal `org.kde.StatusNotifierWatcher` for the smoke test.
 *
 * Electron implements the Linux tray as a StatusNotifierItem client: it looks for
 * a watcher on the session bus, and without one there is nothing to register with
 * (which is exactly what stock GNOME does without an AppIndicator extension). To
 * exercise the real tray code path headlessly we need a host on the bus, so this
 * script owns the name and answers the handful of calls a tray client makes:
 *
 *   RegisterStatusNotifierItem(s)        -> accepted
 *   Properties.Get(IsStatusNotifierHostRegistered | ProtocolVersion | ...)
 *   Properties.GetAll
 *
 * It is a test fixture, not an implementation of the spec, and is never shipped
 * or started by the application.
 */

import dbus from 'dbus-next';

const SERVICE = 'org.kde.StatusNotifierWatcher';
const PATH = '/StatusNotifierWatcher';
const IFACE = SERVICE;
const ITEMS = new Set();

const { Message, Variant, MessageType } = dbus;
const bus = dbus.sessionBus();

const properties = {
  IsStatusNotifierHostRegistered: () => new Variant('b', true),
  IsStatusNotifierRegistered: () => new Variant('b', true),
  ProtocolVersion: () => new Variant('i', 0),
  RegisteredStatusNotifierItems: () => new Variant('as', [...ITEMS]),
};

await new Promise((resolve, reject) => {
  bus.on('connect', resolve);
  bus.on('error', reject);
  setTimeout(() => resolve(), 1_500);
}).catch(() => undefined);

try {
  await bus.requestName(SERVICE, 0);
} catch (error) {
  process.stderr.write(`fake-sni-watcher: could not own ${SERVICE}: ${String(error)}\n`);
  process.exit(1);
}

bus.addMethodHandler((msg) => {
  if (msg.type !== MessageType.METHOD_CALL) return false;
  if (msg.path !== PATH && msg.path !== '/StatusNotifierWatcher') {
    // Anything else on this name: reply with an empty method return so a client
    // does not hang, then keep going.
  }

  const reply = (signature, body) => {
    bus.send(Message.newMethodReturn(msg, signature ?? '', body ?? []));
    return true;
  };
  const fail = (name, text) => {
    bus.send(Message.newError(msg, name, text));
    return true;
  };

  const member = msg.member;
  const iface = msg.interface;

  if (iface === 'org.freedesktop.DBus.Properties' && member === 'Get') {
    const [, name] = msg.body;
    const read = properties[name];
    if (!read) return fail('org.freedesktop.DBus.Error.UnknownProperty', String(name));
    return reply('v', [read()]);
  }
  if (iface === 'org.freedesktop.DBus.Properties' && member === 'GetAll') {
    const entries = Object.entries(properties).map(([key, read]) => [key, read()]);
    return reply('a{sv}', Object.fromEntries(entries));
  }
  if (iface === 'org.freedesktop.DBus.Introspectable' && member === 'Introspect') {
    return reply('s', [INTROSPECTION]);
  }
  if (iface === IFACE && member === 'RegisterStatusNotifierItem') {
    const [service] = msg.body;
    if (typeof service === 'string' && service.length > 0) ITEMS.add(service);
    process.stdout.write(`fake-sni-watcher: registered ${service}\n`);
    return reply('', []);
  }
  if (iface === IFACE && member === 'RegisterStatusNotifierHost') {
    return reply('', []);
  }
  if (iface === IFACE && member === 'UnregisterStatusNotifierItem') {
    const [service] = msg.body;
    ITEMS.delete(service);
    return reply('', []);
  }
  if (msg.destination === SERVICE) {
    // Unknown method on our name: answer instead of letting the caller wait.
    return fail('org.freedesktop.DBus.Error.UnknownMethod', String(member));
  }
  return false;
});

process.stdout.write(`fake-sni-watcher: owning ${SERVICE}\n`);

const keepAlive = setInterval(() => undefined, 60_000);
process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  try {
    bus.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

const INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg name="xml" type="s" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="props" type="a{sv}" direction="out"/>
    </method>
  </interface>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg name="service" type="s" direction="in"/>
    </method>
    <method name="UnregisterStatusNotifierItem">
      <arg name="service" type="s" direction="in"/>
    </method>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="IsStatusNotifierRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg name="service" type="s"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
      <arg name="service" type="s"/>
    </signal>
  </interface>
</node>`;
