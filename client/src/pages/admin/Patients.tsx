import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { apiAdminPatients, ApiError } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

/** §29's patient directory (Day 33). */
export default function Patients() {
  const [search, setSearch] = useState("")
  const [submitted, setSubmitted] = useState("")

  const patients = useQuery({
    queryKey: ["admin", "patients", submitted],
    queryFn: ({ signal }) => apiAdminPatients({ ...(submitted !== "" && { search: submitted }), limit: 100 }, signal),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Patients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every account, including provisional patients created by front-desk bookings.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Directory</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSubmitted(search.trim())
            }}
          >
            <Input
              aria-label="Search patients"
              placeholder="Name, email or phone"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" variant="outline">
              <Search className="size-4" /> Search
            </Button>
            {submitted !== "" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearch("")
                  setSubmitted("")
                }}
              >
                Clear
              </Button>
            )}
          </form>

          {patients.isPending && <PageLoading label="Loading patients…" />}
          {patients.isError && (
            <PageError
              title="Patients could not be loaded"
              message={patients.error instanceof ApiError ? patients.error.message : undefined}
              onRetry={() => void patients.refetch()}
            />
          )}
          {patients.data?.patients.length === 0 && (
            <EmptyState title="No patients found" description="Try a different name, email or phone number." />
          )}
          {patients.data !== undefined && patients.data.patients.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Patient</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Contact</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Visits</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Last visit</th>
                    <th scope="col" className="py-2 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {patients.data.patients.map((patient) => (
                    <tr key={patient.id}>
                      <td className="py-3 pr-3">
                        <p className="font-medium">{patient.fullName}</p>
                        <p className="text-xs text-muted-foreground">
                          Joined {formatSlotDate(patient.createdAt.slice(0, 10))}
                        </p>
                      </td>
                      <td className="py-3 pr-3">
                        <p>{patient.phone}</p>
                        {patient.email !== null && <p className="text-xs text-muted-foreground">{patient.email}</p>}
                      </td>
                      <td className="py-3 pr-3">
                        {patient.completedCount} completed · {patient.noShowCount} no-show ·{" "}
                        {patient.upcomingCount} upcoming
                      </td>
                      <td className="py-3 pr-3">
                        {patient.lastVisitDate === null ? "—" : formatSlotDate(patient.lastVisitDate)}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-1">
                          {patient.isProvisional && <Badge variant="outline">Provisional</Badge>}
                          {patient.isDeactivated && <Badge variant="destructive">Deactivated</Badge>}
                          {patient.returning && <Badge variant="secondary">Returning</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
