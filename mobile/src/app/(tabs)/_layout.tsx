import { Tabs } from 'expo-router';
import { Icon } from '../../components/Icon';
import { useSession } from '../../lib/session';
import { RECENT_MS } from '../../lib/threat';
import { C } from '../../lib/theme';

export default function TabLayout() {
  const ss = useSession();
  // alertes recentes non prises en compte : pastille sur l'onglet
  const open = ss.alerts.filter((a) => !ss.acked.has(a.id) && ss.now - new Date(a.ts).getTime() < RECENT_MS).length;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.acc,
        tabBarInactiveTintColor: C.mut,
        tabBarStyle: { backgroundColor: 'rgba(4,7,12,0.96)', borderTopColor: C.line },
        tabBarLabelStyle: { fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
        sceneStyle: { backgroundColor: C.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Supervision', tabBarIcon: ({ color }) => <Icon name="gauge" color={color} /> }} />
      <Tabs.Screen name="vision" options={{ title: 'Vision', tabBarIcon: ({ color }) => <Icon name="camera" color={color} /> }} />
      <Tabs.Screen name="actionneurs" options={{ title: 'Actionneurs', tabBarIcon: ({ color }) => <Icon name="sliders" color={color} /> }} />
      <Tabs.Screen
        name="alertes"
        options={{
          title: 'Alertes',
          tabBarIcon: ({ color }) => <Icon name="bell" color={color} />,
          tabBarBadge: open || undefined,
          tabBarBadgeStyle: { backgroundColor: C.crit, color: '#fff', fontSize: 10 },
        }}
      />
      <Tabs.Screen name="journal" options={{ title: 'Journal', tabBarIcon: ({ color }) => <Icon name="terminal" color={color} /> }} />
    </Tabs>
  );
}
